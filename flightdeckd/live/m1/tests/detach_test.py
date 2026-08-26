#!/usr/bin/env python3
"""Detachment proof for flightdeckd — M1 acceptance, client side "Mac".

Runs `flightdeckd attach` THROUGH REAL SSH against the M1 container:
  A: attach, run a turn to completion, detach cleanly;
  B: start a slow multi-step turn, SIGKILL the ssh client mid-turn (network
     cut), verify the session finishes the turn with NOBODY attached, then
     reattach with the saved cursor and check the replay carries everything
     missed, including the result frame;
  C: `flightdeckd status` still shows the session alive.

Usage:  python3 m1-daemon/tests/detach_test.py
Env:    PORT (2224), KEY (~/.ssh/flightdeck_m0_ed25519), CWD (/work/demo)
"""
import json, os, signal, subprocess, sys, threading, time, queue

PORT = os.environ.get("PORT", "2224")
KEY = os.path.expanduser(os.environ.get("KEY", "~/.ssh/flightdeck_m0_ed25519"))
CWD = os.environ.get("CWD", "/work/demo")
SSH = ["ssh", "-T", "-p", PORT, "-i", KEY,
       "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
       "agent@127.0.0.1"]

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
    def __init__(self, conversation=None, cwd=None, epoch=None, cursor=0, resume=None):
        args = SSH + ["flightdeckd", "attach"]
        if conversation: args += ["--conversation", conversation]
        if cwd: args += ["--cwd", cwd]
        if resume: args += ["--resume-session", resume]
        if epoch: args += ["--epoch", epoch]
        args += ["--cursor", str(cursor)]
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True)
        self.q = queue.Queue()
        self.cursor = cursor
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.p.stdout:
            line = line.rstrip("\n")
            if not line: continue
            if eligible(line): self.cursor += 1
            self.q.put(line)
        self.q.put(None)

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

def main():
    print(f"== A: attach over ssh (port {PORT}), one full turn, clean detach")
    a = Attach(cwd=CWD)
    _, att = a.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att, "no fd_attach — is the container up and the key injected?"
    conv, epoch = att["conversation"], att["epoch"]
    a.cursor = att["replay_from"]
    print(f"   attached conv={conv} epoch={epoch[:8]}")
    a.send_user("Reply with exactly the word: PING. Nothing else, no tools.")
    got, res = a.read_until(lambda v: jtype(v) == "result", timeout=120)
    assert res and not res.get("is_error"), f"turn A failed: {res}"
    print(f"   turn A ok ({len(got)} lines, cursor={a.cursor})")
    a.p.stdin.close(); time.sleep(0.5); a.kill()

    print("== B: slow turn, SIGKILL ssh mid-turn, finish unattended, reattach + replay")
    b = Attach(conversation=conv, epoch=epoch, cursor=a.cursor)
    _, att2 = b.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att2 and att2["epoch"] == epoch, "reattach epoch mismatch"
    b.cursor = att2["replay_from"]
    b.send_user("Run: sleep 8 && echo DETACH_SURVIVED. Then reply with exactly the single word DONE_B.")
    _, first = b.read_until(lambda v: jtype(v) in ("assistant", "stream_event"), timeout=60)
    assert first, "turn B never started streaming"
    cut = b.cursor
    b.kill()
    print(f"   ssh KILLED mid-turn at cursor={cut}")
    time.sleep(14)

    c = Attach(conversation=conv, epoch=epoch, cursor=cut)
    _, att3 = c.read_until(lambda v: jtype(v) == "fd_attach", timeout=20)
    assert att3, "no fd_attach on reattach"
    assert att3["replay_from"] == cut, f"replay_from {att3['replay_from']} != cut cursor {cut}"
    got, res = c.read_until(lambda v: jtype(v) == "result", timeout=60)
    assert res, "missed-turn result was not replayed"
    assert "DONE_B" in "\n".join(got), "assistant reply missing from replay"
    print(f"   REPLAY OK ({len(got)} lines, incl. the result reached while detached)")

    print("== C: daemon status")
    out = subprocess.run(SSH + ["flightdeckd", "status"], capture_output=True, text=True, timeout=15)
    st = json.loads(out.stdout)
    alive = [c0 for c0 in st["conversations"] if c0["conversation"] == conv and c0["running"]]
    assert alive, f"session not alive in status: {out.stdout}"
    print(f"   session alive: {alive[0]['session_id']}")
    c.p.stdin.close(); time.sleep(0.3); c.kill()
    print("ALL GOOD — detachment over real SSH proven")

if __name__ == "__main__":
    main()
