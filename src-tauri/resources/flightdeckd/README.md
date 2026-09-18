# Bundled `flightdeckd` daemon binaries

This directory is `tauri.conf.json`'s `bundle.resources` source for the static musl
`flightdeckd` binaries the in-app installer (`src-tauri/src/bootstrap/install.rs`)
uploads to a paired Linux server. It is committed with only this README — the
binaries and `manifest.json` are populated by a build step and are gitignored (see
`.gitignore`).

## Populating it

From the repo root:

```bash
pnpm daemon:build                 # both architectures (needs Docker — colima start)
TARGETS=aarch64-unknown-linux-musl pnpm daemon:build   # one architecture only
```

This runs `scripts/build-daemon.mjs`, which drives `flightdeckd/scripts/build-musl.sh`
(see `flightdeckd/README.md` + `flightdeckd/docs/B0-MUSL-SPIKE.md`) and copies its
output here as:

```
flightdeckd/
  flightdeckd-x86_64-unknown-linux-musl
  flightdeckd-aarch64-unknown-linux-musl
  manifest.json
```

`manifest.json` records the daemon's version (from `flightdeckd/Cargo.toml`), a build
timestamp, and each present target's sha256 + byte size — `bootstrap::install::
upload_daemon` verifies a binary's hash against it before ever uploading, and
`bootstrap::orchestrator::ServerDiagnosis::bundled_daemon_version` compares it against
a paired server's own running version to flag one that needs `RepairAction::
ReuploadDaemon`.

## A build WITHOUT this ever having run

`bundle.resources` bundles whatever is here — with no binaries, that's just this
README, and the build still succeeds. At runtime, `bootstrap::install::
daemon_binary_path`/`bundled_daemon_manifest` then report `DaemonBinaryNotBundled`/
`DaemonManifestMissing` for any upload attempt, never a build failure. This is normal
for a fresh clone with no Docker, or a build that intentionally skips daemon bundling.

## Dev/test override

`$TOSSE_FLIGHTDECKD_BIN_DIR` (see `bootstrap::install::TOSSE_FLIGHTDECKD_BIN_DIR_ENV`)
points the resolver at any other directory holding the same three files instead —
always wins over this bundled one. Useful for tests, or to try a binary built
elsewhere (e.g. another checkout's `target/musl/dist/`) without re-running
`pnpm daemon:build`. Note that `tauri dev` itself does NOT need this: Tauri's CLI
copies `bundle.resources` next to the dev binary too (`src-tauri/target/debug/`), so
`resource_dir()` finds this directory the same way it does in a real bundled `.app`.
