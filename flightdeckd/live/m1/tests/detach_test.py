#!/usr/bin/env python3
"""Detachment proof for flightdeckd — M1 acceptance, client side "Mac".

Runs `flightdeckd attach` THROUGH REAL SSH against the M1 container:
  A: attach, run a turn to completion, detach cleanly;
  B: start a slow multi-step turn, SIGKILL the ssh client mid-turn (network
     cut), verify the session finishes the turn with NOBODY attached, then
     reattach with the saved cursor and check the replay carries everything
     missed, including the result frame;
  C: `flightdeckd status` still shows the session alive.
  D: (independent, own throwaway conversation) STALLED-BUT-ALIVE link: SIGSTOP
     the local ssh mid-burst, let the daemon run into its attach write timeout
     (ATTACH_WRITE_TIMEOUT), SIGCONT — the stalled stream must END after the
     kernel/ssh-buffered prefix (+ best-effort fd_detach{stalled}), never dump
     the outage backlog; a reattach from the cursor then replays the rest.
  E: (own throwaway conversation) replay compaction on the wire: after a
     complete turn, a reattach WITHOUT --supports-skip gets the full replay
     (no fd_skip, stream_event deltas included); WITH it, fd_attach.skip is
     true, fd_skip frames arrive gapless (from == cursor + 1), no delta of the
     completed messages is replayed, and the cursor ends on the daemon's seq —
     from 0 and from a cursor in the middle.

Usage:  python3 m1-daemon/tests/detach_test.py [abc] [d] [e]    (default: all)
Env:    TARGET (agent@127.0.0.1), PORT (2224), KEY (~/.ssh/flightdeck_m0_ed25519),
        CWD (/work/demo) — point TARGET/PORT/KEY/CWD at a real server to run it there.
        WRITE_TIMEOUT (20) — the daemon's ATTACH_WRITE_TIMEOUT, in seconds.
Scenario D needs sshd to tolerate a silent client for ~2 min
(ClientAliveInterval 0, or Interval x CountMax above that): if sshd drops the
link instead, the stream also ends and D passes for the wrong reason.
"""
import json, os, random, signal, struct, subprocess, sys, threading, time, queue, zlib

TARGET = os.environ.get("TARGET", "agent@127.0.0.1")
PORT = os.environ.get("PORT", "2224")
KEY = os.path.expanduser(os.environ.get("KEY", "~/.ssh/flightdeck_m0_ed25519"))
CWD = os.environ.get("CWD", "/work/demo")
WRITE_TIMEOUT = float(os.environ.get("WRITE_TIMEOUT", "20"))
SSH = ["ssh", "-T", "-p", PORT, "-i", KEY, "-o", "IdentitiesOnly=yes",
       "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
       TARGET]

CONTROL = {"control_response", "control_request", "control_cancel_request", "keep_alive"}

def eligible(line: str) -> bool:
    """MUST mirror flightdeckd frames::is_replayable_line — the cursor contract."""
    try:
        v = json.loads(line)
    except Exception:
        return False
    t = v.get("type")
    return isinstance(t, str) and t not in CONTROL and not t.startswith("fd_")

class Attach:
    def __init__(self, conversation=None, cwd=None, epoch=None, cursor=0, resume=None, skip=False):
        args = SSH + ["flightdeckd", "attach"]
        if skip: args += ["--supports-skip"]
        if conversation: args += ["--conversation", conversation]
        if cwd: args += ["--cwd", cwd]
        if resume: args += ["--resume-session", resume]
        if epoch: args += ["--epoch", epoch]
        args += ["--cursor", str(cursor)]
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        self.q = queue.Queue()
        self.cursor = cursor
        self.bytes = 0  # bytes received on this link (stdout of the ssh child)
        self.err = []  # ssh's own stderr (auth, host key, connect errors…)
        self.skips = 0  # fd_skip frames applied
        self.skip_errors = []  # fd_skip frames that would leave a cursor gap
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()

    def _pump(self):
        for line in self.p.stdout:
            self.bytes += len(line)
            line = line.rstrip("\n")
            if not line: continue
            if eligible(line):
                self.cursor += 1
            else:
                try:
                    v = json.loads(line)
                except Exception:
                    v = {}
                if v.get("type") == "fd_attach":
                    self.cursor = v["replay_from"]
                elif v.get("type") == "fd_skip":
                    # the client side of the fd_skip contract (M1-DAEMON.md)
                    if v["from"] != self.cursor + 1 or v["to"] < v["from"]:
                        self.skip_errors.append((self.cursor, v))
                    self.cursor = v["to"]
                    self.skips += 1
            self.q.put(line)
        self.q.put(None)

    def _pump_err(self):
        for line in self.p.stderr:
            self.err.append(line.rstrip("\n"))

    def why(self):
        """Suffix for assertion messages: what ssh itself said, if anything."""
        tail = [l for l in self.err if l.strip()][-8:]
        rc = self.p.poll()
        state = f"ssh exited {rc}" if rc is not None else "ssh still running"
        return f" [{state}; ssh stderr: " + (" | ".join(tail) if tail else "(empty)") + "]"

    # The local ssh child: SIGSTOP = the link stalls but stays alive (TCP up,
    # zero window) — unlike kill(), which is a clean cut the daemon sees at once.
    @property
    def pid(self):
        return self.p.pid

    def pause(self):
        os.kill(self.p.pid, signal.SIGSTOP)

    def resume(self):
        os.kill(self.p.pid, signal.SIGCONT)

    def drain_until_eof(self, timeout):
        """Every line until the stream ends. Returns (lines, ended)."""
        t0, got = time.time(), []
        while time.time() - t0 < timeout:
            try:
                line = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if line is None: return got, True
            got.append(line)
        return got, False

    def send_user(self, text):
        frame = {"type": "user", "uuid": f"py-{time.time()}",
                 "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
        self.p.stdin.write(json.dumps(frame) + "\n"); self.p.stdin.flush()

    def read_until(self, pred, timeout=120):
        t0, got = time.time(), []
        while time.time() - t0 < timeout:
            try:
                line = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if line is None: break
            got.append(line)
            try:
                v = json.loads(line)
            except Exception:
                continue
            if pred(v): return got, v
        return got, None

    def kill(self):
        self.p.send_signal(signal.SIGKILL)

def jtype(v): return v.get("type")

def noise_png(w, h, seed):
    """An incompressible PNG. The M1 path buffers ~2.2 MB between the daemon and
    a stopped ssh client (measured: mostly the 2 MB ssh channel window), so
    the burst must outgrow that for the daemon's write to block at all; an
    image Read costs ~1.5k tokens but emits a ~1.3 MB stream-json line."""
    r = random.Random(seed)
    raw = b"".join(b"\x00" + r.randbytes(w * 3) for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b""))

def status_of(conv):
    out = subprocess.run(SSH + ["flightdeckd", "status"], capture_output=True, text=True, timeout=15)
    st = json.loads(out.stdout)
    return next((c for c in st["conversations"] if c["conversation"] == conv), None)

def scenario_d():
    print(f"== D: stalled-but-alive link (SIGSTOP ssh) — daemon must give up after {WRITE_TIMEOUT:.0f}s")
    burst_dir = f"/tmp/fdd-scenario-d-{os.getpid()}"
    images = 4
    subprocess.run(SSH + [f"mkdir -p {burst_dir}"], check=True, timeout=15)
    for i in range(images):
        subprocess.run(SSH + [f"cat > {burst_dir}/noise{i}.png"], input=noise_png(1000, 1000, i),
                       check=True, timeout=60)
    steps = []
    for i in range(images):
        steps.append(f"Bash: echo step-{2 * i}")
        steps.append(f"Read: {burst_dir}/noise{i}.png")
    steps.append("Bash: echo last-step")
    prompt = ("Do these steps strictly in order, ONE tool call per step, no commentary between them:\n"
              + "\n".join(f"{n + 1}. {st}" for n, st in enumerate(steps))
              + "\nThen reply with exactly the single word DONE_D.")

    d = Attach(cwd=CWD)  # a FRESH conversation — independent of A/B/C
    try:
        _, att = d.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
        assert att, "no fd_attach" + d.why()
        conv, epoch = att["conversation"], att["epoch"]
        d.cursor = att["replay_from"]
        print(f"   attached conv={conv}")
        d.send_user(prompt)
        _, first = d.read_until(lambda v: jtype(v) == "assistant", timeout=90)
        assert first, "burst never started" + d.why()
        d.pause()
        cut_cursor, cut_bytes = d.cursor, d.bytes
        print(f"   ssh SIGSTOPped mid-burst (pid {d.pid}) at cursor={cut_cursor}")

        # Let the whole burst land daemon-side (the daemon's write blocks once
        # the in-flight buffers are full), then outlast the write timeout.
        t0 = time.time()
        while time.time() - t0 < 300:
            st = status_of(conv)
            if st and not st["busy"]:
                break
            time.sleep(2)
        else:
            raise AssertionError("burst turn did not finish within 300s")
        print(f"   turn finished daemon-side after {time.time() - t0:.0f}s paused; "
              f"waiting {WRITE_TIMEOUT + 5:.0f}s more")
        time.sleep(WRITE_TIMEOUT + 5)

        d.resume()
        got, ended = d.drain_until_eof(timeout=60)
        after = d.bytes - cut_bytes
        print(f"   SIGCONT: {len(got)} lines / {after / 1e6:.2f} MB delivered after resume, stream ended={ended}")
        assert ended, "the stalled stream never ended — the daemon kept the stalled client attached (pre-D1 behaviour)" + d.why()
        frames = []
        for line in got:
            try:
                frames.append(json.loads(line))
            except Exception:
                frames.append(None)  # the torn tail of a line cut by EOF
        detach = [f for f in frames if f and jtype(f) == "fd_detach"]
        assert all(f.get("reason") == "stalled" for f in detach), f"unexpected detach: {detach}"
        if detach:
            assert frames[-1] is detach[-1], "fd_detach{stalled} must be the last frame"
        assert not any(f and jtype(f) == "result" for f in frames), \
            "the outage backlog (up to the turn's result) was dumped on the stalled link"
        print(f"   fd_detach{{stalled}} delivered: {bool(detach)} (best effort — usually not, the link is full)")

        e = Attach(conversation=conv, epoch=epoch, cursor=d.cursor)
        try:
            _, att2 = e.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
            assert att2 and att2["epoch"] == epoch, "reattach epoch mismatch" + e.why()
            assert att2["replay_from"] == d.cursor, f"replay_from {att2['replay_from']} != cursor {d.cursor}"
            backlog = att2["seq"] - d.cursor
            assert backlog > 0, "no backlog was withheld — the daemon never blocked (burst too small?)"
            replay, res = e.read_until(lambda v: jtype(v) == "result", timeout=60)
            assert res, "the withheld backlog was not replayed" + e.why()
            assert "DONE_D" in "\n".join(replay), "assistant reply missing from replay"
            print(f"   withheld backlog {backlog} lines, replayed from cursor {d.cursor} up to the result")
        finally:
            e.p.stdin.close(); time.sleep(0.3); e.kill()
        subprocess.run(SSH + ["flightdeckd", "stop", "--conversation", conv], capture_output=True, timeout=15)
    finally:
        try:
            d.resume(); d.kill()
        except ProcessLookupError:
            pass
        subprocess.run(SSH + [f"rm -rf {burst_dir}"], capture_output=True, timeout=15)
    print("D GOOD — a stalled link is given up on, not fed the outage")

def read_until_cursor(att_client, att, timeout=60):
    """Every line after fd_attach until the lines CONSUMED here bring the cursor
    to the daemon's seq (the pump thread's own cursor runs ahead of the queue)."""
    t0, got, cur = time.time(), [], att["replay_from"]
    while cur < att["seq"] and time.time() - t0 < timeout:
        try:
            line = att_client.q.get(timeout=1)
        except queue.Empty:
            continue
        if line is None: break
        got.append(line)
        if eligible(line):
            cur += 1
        elif jtype(json.loads(line)) == "fd_skip":
            cur = json.loads(line)["to"]
    return got

def scenario_e():
    print("== E: replay compaction on the wire (fd_skip / --supports-skip)")
    a = Attach(cwd=CWD)  # a FRESH conversation
    try:
        _, att = a.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
        assert att, "no fd_attach" + a.why()
        conv, epoch = att["conversation"], att["epoch"]
        a.send_user("Say one short sentence. Then use the Bash tool to run: echo compaction. "
                    "Then reply with exactly the single word DONE_E.")
        _, res = a.read_until(lambda v: jtype(v) == "result", timeout=120)
        assert res and not res.get("is_error"), f"turn E failed: {res}" + a.why()
        time.sleep(2)  # claude emits a line or two after its result
    finally:
        a.p.stdin.close(); time.sleep(0.3); a.kill()

    def reattach(cursor, skip):
        c = Attach(conversation=conv, epoch=epoch, cursor=cursor, skip=skip)
        _, att = c.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
        assert att and att["epoch"] == epoch, "reattach failed" + c.why()
        lines = read_until_cursor(c, att)
        c.p.stdin.close(); time.sleep(0.3); c.kill()
        return c, att, lines

    try:
        full_c, full_att, full = reattach(0, skip=False)
        assert "skip" not in full_att, f"fd_attach.skip sent to a flagless client: {full_att}"
        assert not any(jtype(json.loads(l)) == "fd_skip" for l in full), "fd_skip sent to a flagless client"
        assert full_c.cursor == full_att["seq"], f"flagless cursor {full_c.cursor} != seq {full_att['seq']}"
        replayable = [l for l in full if eligible(l)]
        deltas = sum(1 for l in replayable if jtype(json.loads(l)) == "stream_event")
        assert deltas > 0, "no stream_event in the replay — nothing to compact, E would prove nothing"
        print(f"   flagless: {len(replayable)} replayable lines ({deltas} stream_event), cursor {full_c.cursor} == seq")

        for start in (0, full_att["seq"] // 2):
            c, att, got = reattach(start, skip=True)
            assert att.get("skip") is True, f"fd_attach.skip missing with --supports-skip: {att}" + c.why()
            assert not c.skip_errors, f"fd_skip left a cursor gap: {c.skip_errors}"
            assert c.cursor == att["seq"], f"compacted cursor {c.cursor} != seq {att['seq']}"
            kept = [l for l in got if eligible(l)]
            if att["seq"] == full_att["seq"]:
                expected = [l for l in replayable[att["replay_from"]:] if jtype(json.loads(l)) != "stream_event"]
                if kept != expected:
                    diff = next((i for i, (x, y) in enumerate(zip(kept, expected)) if x != y), min(len(kept), len(expected)))
                    raise AssertionError(
                        f"the compacted replay (from {start}) differs from the full one minus the deltas: "
                        f"{len(kept)} vs {len(expected)} lines, first difference at {diff}: "
                        f"{kept[diff][:160] if diff < len(kept) else None!r} vs {expected[diff][:160] if diff < len(expected) else None!r}")
            if start == 0:
                assert c.skips >= 1, "no fd_skip received after a complete turn"
                assert "DONE_E" in "\n".join(kept), "the assistant reply is missing from the compacted replay"
            print(f"   --supports-skip from {start}: {len(kept)} lines + {c.skips} fd_skip, "
                  f"cursor {c.cursor} == seq, gapless")
    finally:
        subprocess.run(SSH + ["flightdeckd", "stop", "--conversation", conv], capture_output=True, timeout=15)
    print("E GOOD — fd_skip honoured on the wire, and only when asked")

def scenarios_abc():
    print(f"== A: attach over ssh (port {PORT}), one full turn, clean detach")
    a = Attach(cwd=CWD)
    _, att = a.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att, "no fd_attach — is the container up and the key injected?" + a.why()
    conv, epoch = att["conversation"], att["epoch"]
    a.cursor = att["replay_from"]
    print(f"   attached conv={conv} epoch={epoch[:8]}")
    a.send_user("Reply with exactly the word: PING. Nothing else, no tools.")
    got, res = a.read_until(lambda v: jtype(v) == "result", timeout=120)
    assert res and not res.get("is_error"), f"turn A failed: {res}" + a.why()
    print(f"   turn A ok ({len(got)} lines, cursor={a.cursor})")
    a.p.stdin.close(); time.sleep(0.5); a.kill()

    print("== B: slow turn, SIGKILL ssh mid-turn, finish unattended, reattach + replay")
    b = Attach(conversation=conv, epoch=epoch, cursor=a.cursor)
    _, att2 = b.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att2 and att2["epoch"] == epoch, "reattach epoch mismatch" + b.why()
    b.cursor = att2["replay_from"]
    b.send_user("Run: sleep 8 && echo DETACH_SURVIVED. Then reply with exactly the single word DONE_B.")
    _, first = b.read_until(lambda v: jtype(v) in ("assistant", "stream_event"), timeout=60)
    assert first, "turn B never started streaming" + b.why()
    cut = b.cursor
    b.kill()
    print(f"   ssh KILLED mid-turn at cursor={cut}")
    time.sleep(14)

    c = Attach(conversation=conv, epoch=epoch, cursor=cut)
    _, att3 = c.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att3, "no fd_attach on reattach" + c.why()
    assert att3["replay_from"] == cut, f"replay_from {att3['replay_from']} != cut cursor {cut}"
    got, res = c.read_until(lambda v: jtype(v) == "result", timeout=60)
    assert res, "missed-turn result was not replayed" + c.why()
    assert "DONE_B" in "\n".join(got), "assistant reply missing from replay"
    print(f"   REPLAY OK ({len(got)} lines, incl. the result reached while detached)")

    print("== C: daemon status")
    out = subprocess.run(SSH + ["flightdeckd", "status"], capture_output=True, text=True, timeout=15)
    st = json.loads(out.stdout)
    alive = [c0 for c0 in st["conversations"] if c0["conversation"] == conv and c0["running"]]
    assert alive, f"session not alive in status: {out.stdout}"
    print(f"   session alive: {alive[0]['session_id']}")
    c.p.stdin.close(); time.sleep(0.3); c.kill()
    print("ABC GOOD — detachment over real SSH proven")

def main():
    which = "".join(sys.argv[1:]).lower() or "abcde"
    if "a" in which or "b" in which or "c" in which:
        scenarios_abc()
    if "d" in which:
        scenario_d()
    if "e" in which:
        scenario_e()
    print("ALL GOOD")

if __name__ == "__main__":
    main()
