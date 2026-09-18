# `flightdeckd` — Flight Deck server daemon

Owns detached `claude` sessions and serves them to SSH-attached clients (the
Flight Deck Mac app) and to a relay (the phone PWA). A session survives an
SSH disconnect and replays what a client missed on reattach (ring buffer,
`fd_*` frames). Protocol contract: [`docs/M1-DAEMON.md`](docs/M1-DAEMON.md).

## History

Developed 2026-08 through 2026-09-18 in its own repository,
`flightdeck-server`. On 2026-09-18 (Armand's decision) it moved into
`tosse-code`, the monorepo of the app it serves, **with its git history
preserved** — see [`docs/MONOREPO-MOVE.md`](docs/MONOREPO-MOVE.md) for the
inventory, dependency analysis and the `git filter-repo` procedure used, and
[`docs/flightdeck-server-commit-map.txt`](docs/flightdeck-server-commit-map.txt)
to trace an old SHA (from the CRM, a deploy record, or `josty-cc`) to its new
commit here.

`flightdeck-server` is now archived history: **do not develop against it
anymore**. This crate is the current source of truth.

Imported as a **standalone package** first (its own `Cargo.toml` and
`Cargo.lock`, not a member of a Cargo workspace) — the lower-risk variant of
the move. Folding it into a shared workspace with `src-tauri/` (one
`Cargo.lock`, shared `target/`, `[profile.daemon]`) is a later task; see
`docs/MONOREPO-MOVE.md` §4/§7.

## Build & test

Standalone crate — from this directory:

```bash
cargo test                          # unit + integration tests
cargo build --release               # native build for this machine
```

Static Linux binaries (musl, for the real deploy target) — `scripts/`
auto-detect whether the crate is standalone (today) or a workspace member
(once §4 lands), so these work unchanged either way:

```bash
scripts/build-musl.sh                                   # both architectures
TARGETS=aarch64-unknown-linux-musl scripts/build-musl.sh # one architecture
scripts/build-musl.sh --print-dist-dir                   # where binaries land
scripts/smoke-musl.sh                                     # ldd + --version + init + run/TLS + status, per arch
```

## Live harnesses (need Docker, not run in CI)

- **`live/bootstrap-fixtures/`** — four throwaway, password-auth Ubuntu 20.04
  containers exercising the Mac app's "Add a server" installer (fresh node,
  root login, already-bootstrapped node, no-sudo node). See
  [`docs/B6-FIXTURES.md`](docs/B6-FIXTURES.md).
  ```bash
  live/bootstrap-fixtures/fixture.sh up    all
  live/bootstrap-fixtures/fixture.sh check all
  live/bootstrap-fixtures/fixture.sh down  all
  ```
- **`live/m1/`** — the M1 container: `flightdeckd` + `claude` + sshd, proving
  detach/reattach over a real SSH cut and a phone-driven turn with the Mac
  off. See [`docs/M1-DAEMON.md`](docs/M1-DAEMON.md).
  ```bash
  live/m1/scripts/up.sh                    # flightdeck-m1, ssh on 127.0.0.1:2224
  python3 live/m1/tests/detach_test.py
  node live/m1/tests/phone-cut-test.mjs
  ```

The Mac app's own `#[ignore]`d live tests (`src-tauri/src/bootstrap/*.rs`,
`src-tauri/src/supervisor/{transport,session}.rs`) drive these same fixtures
and containers; run with `cargo test --lib -- --ignored --nocapture` from
`src-tauri/`.

## Layout

```
flightdeckd/
  src/           the daemon
  tests/         cargo integration tests (unix sockets, CLI, config lock, shutdown)
  scripts/       build-musl.sh, smoke-musl.sh, lib-layout.sh (workspace/standalone detection)
  docs/          protocol contract, design docs, this move's plan + commit map
  live/
    m1/                the M1 acceptance container + its Python/Node tests
    bootstrap-fixtures/ the four installer test fixtures
```
