# Cadrage — Flight Deck Server (always-on remote workstation)

> Design decided in a Flight Deck brainstorm on 2026-08-24 with Armand.
> Canonical copy lives in TOSSE project `fa059422`. This file makes the repo
> self-sufficient. **Alpha 2.0 target.**

## Use case

Armand's work = talking to Claude, remotely, from anywhere — often on a weak/flaky
link (train) or none (hike), with a laptop too light for heavy tasks. Solution: a
controlled **always-on** Linux server (decent specs) becomes the **main
workstation**. Mac and phone are **disposable windows** that attach/detach without
killing the work.

## 4 locked invariants

1. **Detached sessions** — a launched agent keeps running when the client's link
   drops; you reconnect and find the live state. *(This is the requirement that
   picks the daemon over plain SSH: SSH-only simulates detachment poorly;
   a daemon does it natively, exactly as Flight Deck already does locally.)*
2. **Server = home** of repos AND conversations. Git stays the escape hatch for
   occasional local work on the Mac. No bidirectional sync.
3. **Full-trust** — the paired Mac drives the server with **no restriction**
   (unlike the phone's safe blacklist). The phone stays phone-safe.
4. **App layer decoupled from the network** — NAT / encryption / changing IP are
   decided **later**; the daemon listens on a port, reached however we choose.

## Remote conversation history

Flight Deck persists **no messages** (only metadata in SQLite); messages live in
Claude's on-disk transcripts. The remote `claude` writes its transcript **on the
server** → remote history lives natively on the server, read remotely on open (no
copy/sync). A conversation belongs to the machine it runs on and does not migrate.

## Target architecture: headless daemon

`flightdeckd` = headless Linux daemon embedding the **existing `tosse-code` core
without Tauri**: Claude/Codex session supervisor (owns detached sessions),
fs/git/terminal re-exposed identically, native file-watch (local `notify` → real-
time push), SQLite registry of convs/repos, an application port forwarding the
already-normalized events (native stream). Headless-first; "GUI-capable"
(Playwright/screenshots) = just a virtual display (Xvfb) on the server, **same
daemon/protocol** (images already come back inside `tool_result`s).

## Machine boundary (Mac side)

One internal transport interface (`list_repos`, `browse`, `spawn_session`,
`stream_events`, fs ops, terminal ops) with two impls: `Local` (today) and
`Remote`. The UI only sees the abstraction → UI + data model (60-70% of the
product) are identical regardless of transport.

## Alpha path: SSH-first (nothing is thrown away)

- **Alpha**: `Remote` impl = SSH (spawn remote claude, native PTY, SFTP, read
  remote transcript). Little code, validates the multi-machine UX.
- **V3**: `Remote` impl = daemon client (native detachment/watch/stream). SSH
  stays as a "zero-install" fallback.
- The SSH code is **not** disposable: in V3 it becomes (a) the daemon's
  install/pairing **bootstrap** and (b) the fallback network tunnel (`ssh -L` →
  zero network config at first).

## Onboarding

The "Remote servers → Add a server" page gives **one command** to paste on the
server. It installs the daemon AND emits a **self-sufficient pairing ticket**
(endpoint, token, daemon public key, throwaway dedicated SSH key if needed) →
pasted into Flight Deck → connected. This flips the bootstrap (the server presents
itself; Flight Deck no longer needs your SSH creds). Guards: command served by
**us** over HTTPS, ticket signed/verifiable.

## Multi-target remote (phone)

The server becomes a `/mac` on the existing relay (the daemon embeds the relay
client ≈ `relay.rs`) → the phone talks to the server **directly, even with the Mac
off** (crucial for hike/urgency; Web Push already there). Rejected:
phone→Mac→server (would need the Mac on). PWA becomes multi-target (multi-pairing +
"My Mac / Server" selector). The Mac stays the **admin console**: phone↔server
pairing is orchestrated from the Mac (QR shown on the Mac's screen, server being
headless). Two trust levels kept: Mac full / phone phone-safe even toward the
server.

## Claude account

The remote `claude` consumes the account configured **on the server**
(`~/.claude` there). To be assumed (which Max plan lives there).
