# Bundled `flightdeckd` daemon binaries

This directory is `tauri.conf.json`'s `bundle.resources` source for the `flightdeckd`
binaries the app uploads to a paired server (`src-tauri/src/bootstrap/install.rs`):

- the static **Linux musl** builds, which the in-app installer puts on a fresh Linux
  server (and updates there);
- the **macOS** builds, which only ever UPDATE an existing macOS install — one that a
  single LaunchAgent of the logged-in user runs, set up by hand (Flight Deck never
  installs a fresh Mac: the daemon has to run inside the user's session to reach
  Claude's Keychain login). "Update the daemon" in the server panel replaces the binary
  that LaunchAgent runs — offered only when the server's diagnosis confirms it is that
  one, that Flight Deck's own commands run it too, and that the SSH login can write its
  folder (`orchestrator::judge_mac_update`, `ServerDiagnosis::mac_daemon_update`;
  otherwise the panel says why and what to do by hand). It runs over plain SSH, so a Mac
  added with its owner's own SSH keys gets it too. "Restart the daemon" then makes
  launchd run it — refused while a conversation is busy, since a restart ends every
  conversation on the server.

It is committed with only this README — the binaries and `manifest.json` are populated
by a build step and are gitignored (see `.gitignore`).

## Populating it

From the repo root:

```bash
pnpm daemon:build                 # Linux both arches (Docker — colima start);
                                  # on a Mac, the macOS builds its Rust toolchain has
TARGETS=aarch64-unknown-linux-musl pnpm daemon:build      # only the listed triples
TARGETS="x86_64-apple-darwin aarch64-apple-darwin" pnpm daemon:build   # macOS only (on a Mac)
```

This runs `scripts/build-daemon.mjs`, which drives `flightdeckd/scripts/build-musl.sh`
for the Linux triples (see `flightdeckd/README.md` + `flightdeckd/docs/B0-MUSL-SPIKE.md`)
and `cargo build --release --target <triple> --target-dir flightdeckd/target` for the
macOS ones — those need a Mac with the Rust targets installed
(`rustup target add x86_64-apple-darwin aarch64-apple-darwin`). A default run builds the
ones this Mac's toolchain has and skips the others, saying so (and how to add them)
before the Docker build starts; elsewhere it skips both. Asking for one explicitly
(`TARGETS=…`) that can't be built fails up front instead. Each macOS binary is ad-hoc
code-signed BEFORE it is hashed (an
Apple-silicon Mac runs no unsigned binary, and the app bundle is itself signed with
these files inside). The output lands here as:

```
flightdeckd/
  flightdeckd-x86_64-unknown-linux-musl
  flightdeckd-aarch64-unknown-linux-musl
  flightdeckd-x86_64-apple-darwin
  flightdeckd-aarch64-apple-darwin
  manifest.json
```

`manifest.json` records the daemon's version (from `flightdeckd/Cargo.toml` — ONE version
for every target, all built from the same commit), a build timestamp, and each packaged
target's sha256 + byte size — `bootstrap::install::upload_daemon` verifies a binary's
hash against it before ever uploading, `bootstrap::orchestrator::ServerDiagnosis::
bundled_daemon_version` compares it against a paired server's own running version to
flag one that needs `RepairAction::ReuploadDaemon`, and `ServerDiagnosis::
bundled_daemon_for_host` says whether this bundle has a build for that server's OS/CPU
at all (the panel only offers "Update the daemon" on a Mac when it does).

A run packages only what it built — never a leftover binary from an earlier run listed
under the new version. `--include-prebuilt` also packages binaries already sitting in
the dist dirs (`flightdeckd/target/musl/dist/`, `flightdeckd/target/darwin/dist/`);
`--skip-build` packages whatever is there without building.

## Releases

`.github/workflows/release.yml` builds the musl binaries on Linux (Docker, pinned
tooling), then the macOS job builds the two macOS ones on its own runner, packages all
four under one manifest (`--include-prebuilt`), runs both macOS builds' `--version`
against the manifest (the x86_64 one — what an Intel Mac server receives — under
Rosetta 2 on an Apple-silicon runner) after checking their architecture and signature,
and — after the Tauri build — checks the bundled binaries inside the built `.app` still
match their manifest before publishing.

## A build WITHOUT this ever having run

`bundle.resources` bundles whatever is here — with no binaries, that's just this
README, and the build still succeeds. At runtime, `bootstrap::install::
daemon_binary_path`/`bundled_daemon_manifest` then report `DaemonBinaryNotBundled`/
`DaemonManifestMissing` for any upload attempt, never a build failure. This is normal
for a fresh clone with no Docker, or a build that intentionally skips daemon bundling.
A bundle made off a Mac simply carries no macOS build: an outdated Mac server is then
told to update by hand, with no button that would fail.

## Dev/test override

`$TOSSE_FLIGHTDECKD_BIN_DIR` (see `bootstrap::install::TOSSE_FLIGHTDECKD_BIN_DIR_ENV`)
points the resolver at any other directory holding the same files instead —
always wins over this bundled one. Useful for tests, or to try a binary built
elsewhere (e.g. another checkout's `target/musl/dist/`) without re-running
`pnpm daemon:build`. Note that `tauri dev` itself does NOT need this: Tauri's CLI
copies `bundle.resources` next to the dev binary too (`src-tauri/target/debug/`), so
`resource_dir()` finds this directory the same way it does in a real bundled `.app`.
