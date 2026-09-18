// Builds the static musl flightdeckd binaries (via flightdeckd/scripts/build-musl.sh,
// which needs Docker — `colima start` on this Mac) and packages them + a generated
// manifest.json into src-tauri/resources/flightdeckd/ — the directory tauri.conf.json's
// bundle.resources embeds into the app, resolved at runtime by
// bootstrap::install::daemon_binary_path / bundled_daemon_manifest (src-tauri/src/
// bootstrap/install.rs).
//
// Usage:
//   pnpm daemon:build                                       # both architectures
//   TARGETS=aarch64-unknown-linux-musl pnpm daemon:build     # one architecture only
//   pnpm daemon:build --skip-build                           # package whatever is
//     already in flightdeckd/target/musl/dist/ instead of invoking Docker — e.g. after
//     manually dropping in a binary built/copied from elsewhere (see flightdeckd/README.md
//     and src-tauri/resources/flightdeckd/README.md).
//
// A build that never ran this (a fresh clone with no Docker) still succeeds: the
// resources directory is committed with only a README, and tauri.conf.json bundles
// whatever is there — see src-tauri/resources/flightdeckd/README.md.
//
// Manifest schema: { version, built_at, targets: { <target-triple>: { sha256, size } } }.
// `version` is read from flightdeckd/Cargo.toml — ONE version for the whole manifest,
// since both target triples are always built from the same commit.
//
// Self-test (not wired into `pnpm test` — see vitest.config.ts's own "src/**" scope):
//   node --test scripts/build-daemon.test.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FLIGHTDECKD_DIR = path.join(REPO_ROOT, "flightdeckd");
export const DIST_DIR = path.join(FLIGHTDECKD_DIR, "target/musl/dist");
export const RESOURCES_DIR = path.join(REPO_ROOT, "src-tauri/resources/flightdeckd");

// Mirrors `daemon_binary_filename`/`daemon_target_triple` in
// src-tauri/src/bootstrap/install.rs — keep these two in sync (duplicated on purpose:
// the Rust side already explains why it derives its own filename from this same
// convention rather than reading it back out of the manifest it doesn't control).
export const TARGET_TRIPLES = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];

/** The `version = "..."` line of flightdeckd/Cargo.toml's `[package]` table. */
export function readDaemonVersion(cargoTomlText) {
  const m = cargoTomlText.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('could not find version = "..." in flightdeckd/Cargo.toml');
  return m[1];
}

/**
 * Pure: builds the manifest object from a list of `{ triple, sha256, size }` — one per
 * target actually present (a `TARGETS=`-limited build produces just one; that's fine,
 * see DaemonManifest's own doc on the Rust side). Exported so
 * scripts/build-daemon.test.mjs can check its shape without touching the filesystem or
 * Docker.
 */
export function buildManifest(version, builtAt, presentTargets) {
  const targets = {};
  for (const { triple, sha256, size } of presentTargets) {
    targets[triple] = { sha256, size };
  }
  return { version, built_at: builtAt, targets };
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");

  if (!skipBuild) {
    const targetsNote = process.env.TARGETS ? `TARGETS=${process.env.TARGETS}` : "both targets";
    console.log(`· running flightdeckd/scripts/build-musl.sh (${targetsNote}, needs Docker)`);
    execFileSync(path.join(FLIGHTDECKD_DIR, "scripts/build-musl.sh"), [], {
      stdio: "inherit",
      cwd: FLIGHTDECKD_DIR,
    });
  } else {
    console.log(`· --skip-build: packaging whatever is already in ${DIST_DIR}`);
  }

  if (!existsSync(DIST_DIR)) {
    console.error(`✗ ${DIST_DIR} does not exist — nothing to package. Run without --skip-build first.`);
    process.exitCode = 1;
    return;
  }

  const present = TARGET_TRIPLES.map((triple) => ({ triple, path: path.join(DIST_DIR, `flightdeckd-${triple}`) })).filter(
    ({ path: p }) => existsSync(p),
  );

  if (present.length === 0) {
    console.error(`✗ no flightdeckd-<triple> binaries found in ${DIST_DIR}`);
    process.exitCode = 1;
    return;
  }

  const version = readDaemonVersion(readFileSync(path.join(FLIGHTDECKD_DIR, "Cargo.toml"), "utf8"));
  const manifest = buildManifest(
    version,
    new Date().toISOString(),
    present.map(({ triple, path: p }) => ({ triple, sha256: sha256File(p), size: statSync(p).size })),
  );

  mkdirSync(RESOURCES_DIR, { recursive: true });
  // Clear out any PREVIOUSLY bundled binaries/manifest first — a stale binary left over
  // from an earlier, TARGETS=-limited run must never survive silently alongside a fresh
  // manifest that no longer mentions it (the README/.gitkeep this directory is committed
  // with is left untouched).
  for (const entry of readdirSync(RESOURCES_DIR)) {
    if (entry.startsWith("flightdeckd-") || entry === "manifest.json") {
      rmSync(path.join(RESOURCES_DIR, entry));
    }
  }
  for (const { triple, path: p } of present) {
    copyFileSync(p, path.join(RESOURCES_DIR, `flightdeckd-${triple}`));
  }
  writeFileSync(path.join(RESOURCES_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `✓ packaged ${present.length} binaries (${present.map((p) => p.triple).join(", ")}) into ${RESOURCES_DIR}`,
  );
  console.log(`  version ${version}`);
  for (const [triple, t] of Object.entries(manifest.targets)) {
    console.log(`  ${triple}: ${t.size} bytes, sha256 ${t.sha256}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
