# M0 — a remote conversation, inside the real Flight Deck app

This is the M0 milestone wired into the actual Flight Deck desktop app
(`tosse-code`): a conversation runs on a **remote Linux container** over SSH, and
you drive it from the app exactly like a local one — same thread, same "…" working
indicator, same streamed answer. Only the `claude` process moved to the container.

> The standalone transport proof (no app) lives in [`../m0-ssh-remote/`](../m0-ssh-remote/).
> This doc is the app-integrated version built on top of it.

## Where the code is

- **App changes**: `tosse-code`, branch **`feat/remote-ssh`** (an isolated git
  worktree at `tosse-code/.claude/worktrees/feat-remote-ssh`). `dev` is untouched;
  nothing was pushed. Review/merge is Armand's call.
- **The seam** (the whole feature, in one place): `SpawnConfig` gained an optional
  `remote` target, and `Transport::spawn` (`src-tauri/src/supervisor/transport.rs`)
  launches `ssh <host> "cd <repo> && exec claude <same stream-json argv>"` instead of
  a local `claude`. Everything above the transport — the stream, the session actor,
  the event bus, the UI — is byte-for-byte unchanged.
- A repo is "remote" when its persisted `ssh_target` is set (new nullable column,
  SQLite migration v9; `NULL` = local = unchanged).

## The 60-second demo

The container (`flightdeck-m0`) and its `/work/demo` repo already exist (see
`../m0-ssh-remote/`). To open the app already connected to it:

```bash
cd flightdeck-server/m0-ssh-remote
./scripts/open-flightdeck-remote.sh
```

That refreshes the container's Claude credentials, generates the SSH alias config,
and launches **Flight Deck dev build** (isolated data — it will NOT touch your real
Flight Deck conversations). In the app:

1. Open the **“Remote demo (flightdeck-m0)”** conversation in the sidebar.
2. Send a message — e.g. *“What does this repo do? Read the files.”*
3. Watch the **“…”** indicator, then the streamed answer. That `claude` is running
   **inside the container**, in `/work/demo`, on your Max account — ask it to run
   `hostname` / `uname -a` and it will say `flightdeck-m0` / Linux.

## How to connect a remote repo yourself

A remote repo needs two things: **you can `ssh` to the host**, and **Flight Deck
knows the repo is remote** (its `ssh_target`).

**1 — Be able to `ssh <host>`.** Host specifics (port, key, known-hosts) live in an
SSH config, never in the app. For the demo container, this is the block (already
generated at `m0-ssh-remote/.secrets/ssh_config`; paste it into `~/.ssh/config` if
you want a Finder-launched app to reach it too):

```sshconfig
Host flightdeck-m0
    HostName 127.0.0.1
    Port 2222
    User agent
    IdentityFile <repo>/m0-ssh-remote/.secrets/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
```

For a real server, a normal `Host myserver … IdentityFile ~/.ssh/id_ed25519` block is
all it takes. The app points its SSH transport at a dedicated config via the
`TOSSE_SSH_CONFIG` env var (the launcher sets it); with a `~/.ssh/config` entry it
works with no env at all.

**2 — Register the repo as remote.** A remote repo is a normal repo whose
`ssh_target` is the SSH destination (the `Host` alias, e.g. `flightdeck-m0`) and
whose `path` is the repo path **on that host** (e.g. `/work/demo`). Today it is
created for you (the demo seed, or `upsert_repo` with `ssh_target` set); a one-click
**“Add remote server”** form in the sidebar is the natural next step (deliberately
left out of this first cut — see below). Once the repo exists, **every** conversation
you start in it runs remotely, and new conversations appear under it in the sidebar
like any other repo.

## What's in this first cut (and what's deferred)

Deliberately the **narrowest** thing that proves the alpha end-to-end:

- ✅ The **conversation stream** is fully remote (spawn, send, interrupt, stop, the
  "…" indicator, the streamed answer, permissions) — the 60–70% of the product that
  is "talk to Claude".
- ⏸️ **Editor / git / terminal panels** still read the **local** Mac (they're opened
  on demand, so they just sit empty/inert for a remote repo — no crash). Remoting
  them over SFTP / an SSH PTY is the next milestone.
- ⏸️ **Reload / history / `--resume`** of a remote conversation isn't replayed: the
  transcript lives on the container. A live session is unaffected; a cold reopen
  won't show past turns yet.
- ⏸️ A polished **“Add remote server”** UI (the seed + `upsert_repo` do it today).

## Auth note (important for the demo)

The container's `claude` uses your **Max account** via the OAuth token copied from
your Mac's Keychain. That token is **rotated** by your local `claude` over time, so a
copy injected hours ago goes stale ("OAuth session expired"). The launcher
**re-injects a fresh token** each time it opens the app, which covers a demo session.
The robust fix (a real server logs in with its **own** account, per the CADRAGE) is a
later step.
