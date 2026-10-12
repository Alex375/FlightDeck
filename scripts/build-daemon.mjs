// Builds the flightdeckd daemon binaries the app bundles and packages them + a
// generated manifest.json into src-tauri/resources/flightdeckd/ — the directory
// tauri.conf.json's bundle.resources embeds into the app, resolved at runtime by
// bootstrap::install::daemon_binary_path / bundled_daemon_manifest (src-tauri/src/
// bootstrap/install.rs).
//
// Two families of targets, built two different ways:
//   - Linux (x86_64/aarch64-unknown-linux-musl): static musl binaries, cross-compiled in
//     Docker by flightdeckd/scripts/build-musl.sh (`colima start` on a Mac). What the
//     in-app installer puts on a fresh Linux server.
//   - macOS (x86_64/aarch64-apple-darwin): plain `cargo build --release --target …` —
//     only on a Mac (Apple's SDK and linker; no cross-compile from Linux). What an
//     UPDATE of an existing macOS LaunchAgent install sends (a fresh Mac install stays
//     the owner's job — see orchestrator::judge_mac_update). Each one is ad-hoc
//     code-signed BEFORE it is hashed: an x86_64 Mach-O comes out of the linker unsigned,
//     an Apple-silicon Mac won't run an unsigned binary, and the app bundle is itself
//     code-signed with these files inside it — so the manifest records the signed bytes,
//     the exact bytes the app later uploads.
//
// Usage:
//   pnpm daemon:build                    # Linux both arches; on a Mac, the macOS ones
//     # whose Rust target is installed too (`rustup target add …`) — the others are
//     # skipped, said so BEFORE the Docker build starts, never a failure at its end
//   TARGETS=aarch64-unknown-linux-musl pnpm daemon:build     # only the listed triples
//   TARGETS="x86_64-apple-darwin aarch64-apple-darwin" pnpm daemon:build --include-prebuilt
//     # build the macOS ones and package them WITH Linux binaries already sitting in
//     # flightdeckd/target/musl/dist/ (the release workflow's macOS job: it downloads the
//     # Linux binaries the Docker job built there, then builds the macOS ones itself)
//   pnpm daemon:build --skip-build       # package whatever is already in both dist dirs
//     instead of building anything — e.g. after manually dropping in a binary built or
//     copied from elsewhere (see flightdeckd/README.md and
//     src-tauri/resources/flightdeckd/README.md).
//
// What gets packaged: the triples THIS run built (plus, with --include-prebuilt, any
// other triple already present in its dist dir); with --skip-build, every triple
// present. Never a leftover from an earlier run silently: the manifest carries ONE
// version (flightdeckd/Cargo.toml's), and a stale binary listed under it would make the
// app re-upload an old daemon as the new one forever.
//
// A build that never ran this (a fresh clone with no Docker) still succeeds: the
// resources directory is committed with only a README, and tauri.conf.json bundles
// whatever is there — see src-tauri/resources/flightdeckd/README.md.
//
// Manifest schema: { version, built_at, targets: { <target-triple>: { sha256, size } } }.
// `version` is read from flightdeckd/Cargo.toml — ONE version for the whole manifest,
// since every target triple is built from the same commit.
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
export const DARWIN_DIST_DIR = path.join(FLIGHTDECKD_DIR, "target/darwin/dist");
export const RESOURCES_DIR = path.join(REPO_ROOT, "src-tauri/resources/flightdeckd");

// Mirrors `daemon_binary_filename`/`daemon_target_triple` in
// src-tauri/src/bootstrap/install.rs — keep these in sync (duplicated on purpose: the
// Rust side already explains why it derives its own filename from this same convention
// rather than reading it back out of the manifest it doesn't control). The Rust test
// `bundled_triples_match_build_daemon_mjs` reads this literal and fails on any drift.
export const TARGET_TRIPLES = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
];

/** A macOS triple — built with plain cargo on a Mac, never in the musl Docker builder. */
export function isDarwinTriple(triple) {
  return triple.endsWith("-apple-darwin");
}

export const LINUX_TRIPLES = TARGET_TRIPLES.filter((t) => !isDarwinTriple(t));
export const DARWIN_TRIPLES = TARGET_TRIPLES.filter(isDarwinTriple);

/** Where `triple`'s built binary sits before packaging (`flightdeckd-<triple>`). */
export function distPathFor(triple) {
  return path.join(isDarwinTriple(triple) ? DARWIN_DIST_DIR : DIST_DIR, `flightdeckd-${triple}`);
}

/**
 * Pure: which triples this run builds, split by how — from `$TARGETS` (space- or
 * comma-separated; unset or blank = the default), the host platform
 * (`process.platform`) and `installed`, the Rust targets this Mac's toolchain can build
 * (`installedRustTargets()`; `null` when no toolchain answered). `skipped` lists, with
 * why, the macOS triples a DEFAULT run leaves out.
 *
 * The default is every Linux triple, plus every macOS one this Mac can build: one whose
 * Rust target isn't installed (an Intel Mac rarely has `aarch64-apple-darwin`; cargo
 * installed without rustup has no cross target at all) is skipped and said so — the
 * plan is made before the Docker build starts, so a default run never fails minutes in,
 * after the Linux builds, for a target nobody asked for. Off a Mac the macOS ones are
 * skipped (Apple's SDK and linker). An EXPLICIT request is never trimmed: a macOS triple
 * on a non-Mac host, one whose Rust target isn't installed, or a triple this app doesn't
 * know throws — asking for something that can't be built is never silently skipped.
 */
export function planTargets(targetsEnv, hostPlatform, installed = null) {
  const requested = (targetsEnv ?? "").split(/[\s,]+/).filter(Boolean);
  const onMac = hostPlatform === "darwin";
  const buildable = (t) => installed !== null && installed.includes(t);
  if (requested.length === 0) {
    if (!onMac) {
      const why = "macOS daemons can only be built on a Mac";
      return { linux: [...LINUX_TRIPLES], darwin: [], skipped: DARWIN_TRIPLES.map((triple) => ({ triple, why })) };
    }
    const skipped = DARWIN_TRIPLES.filter((t) => !buildable(t)).map((triple) => ({
      triple,
      why:
        installed === null
          ? "no Rust toolchain answered (rustup/rustc) — the macOS daemons are built with cargo"
          : `its Rust target isn't installed — rustup target add ${triple}`,
    }));
    return { linux: [...LINUX_TRIPLES], darwin: DARWIN_TRIPLES.filter(buildable), skipped };
  }
  const unknown = requested.filter((t) => !TARGET_TRIPLES.includes(t));
  if (unknown.length > 0) {
    throw new Error(`unknown target triple(s): ${unknown.join(", ")} — known: ${TARGET_TRIPLES.join(", ")}`);
  }
  const darwin = DARWIN_TRIPLES.filter((t) => requested.includes(t));
  if (darwin.length > 0 && !onMac) {
    throw new Error(`${darwin.join(", ")} can only be built on a Mac (Apple's SDK and linker) — this host is ${hostPlatform}`);
  }
  // Only when the toolchain answered: without an answer, cargo itself says what is wrong.
  const missing = installed === null ? [] : darwin.filter((t) => !buildable(t));
  if (missing.length > 0) {
    throw new Error(`the Rust target of ${missing.join(", ")} isn't installed — rustup target add ${missing.join(" ")}`);
  }
  return { linux: LINUX_TRIPLES.filter((t) => requested.includes(t)), darwin, skipped: [] };
}

/**
 * The Rust targets this host's toolchain can build, as seen from flightdeckd/ (so a
 * toolchain override there counts): `rustup target list --installed`, else — cargo
 * installed without rustup — the one host target `rustc -vV` reports (its std is always
 * there), else `null` (no toolchain answered). `run` is injectable for the tests.
 */
export function installedRustTargets(run = execFileSync) {
  const opts = { cwd: FLIGHTDECKD_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  try {
    return run("rustup", ["target", "list", "--installed"], opts).split(/\s+/).filter(Boolean);
  } catch {
    // No rustup (or no default toolchain): ask rustc for the one target it always has.
  }
  try {
    const host = run("rustc", ["-vV"], opts).match(/^host:\s*(\S+)/m);
    return host ? [host[1]] : [];
  } catch {
    return null;
  }
}

/**
 * Pure: the triples to package, in TARGET_TRIPLES order. `built` — what this run built;
 * `present` — triples whose binary sits in its dist dir right now. `skipBuild`: every
 * present one (nothing was built, packaging what is there is the whole point).
 * Otherwise only what was built, plus — with `includePrebuilt` — whatever else is
 * present. A built triple whose binary is missing throws: the build said it succeeded,
 * so a missing output is a bug, never a smaller manifest.
 */
export function selectPackaged({ built, present, skipBuild, includePrebuilt }) {
  if (!skipBuild) {
    const missing = built.filter((t) => !present.includes(t));
    if (missing.length > 0) throw new Error(`built but missing from its dist dir: ${missing.join(", ")}`);
  }
  const keep = skipBuild || includePrebuilt ? present : built;
  return TARGET_TRIPLES.filter((t) => keep.includes(t));
}

/** The `version = "..."` line of flightdeckd/Cargo.toml's `[package]` table. */
export function readDaemonVersion(cargoTomlText) {
  const m = cargoTomlText.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('could not find version = "..." in flightdeckd/Cargo.toml');
  return m[1];
}

/**
 * Pure: builds the manifest object from a list of `{ triple, sha256, size }` — one per
 * target actually packaged (a `TARGETS=`-limited build produces just those; that's
 * fine, see DaemonManifest's own doc on the Rust side). Exported so
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

/**
 * Pure: the cargo invocation that builds `triple`'s daemon, and where its binary lands.
 * `--target-dir` pins the output under flightdeckd/target whatever the environment says
 * (`$CARGO_TARGET_DIR`, `$CARGO_BUILD_TARGET_DIR`, a `build.target-dir` config): the copy
 * below reads it from there, and a developer with a shared target dir exported used to
 * get ENOENT right after a successful build.
 */
export function darwinBuild(triple) {
  const targetDir = path.join(FLIGHTDECKD_DIR, "target");
  return {
    args: ["build", "--release", "--locked", "--target", triple, "--target-dir", targetDir],
    binary: path.join(targetDir, triple, "release/flightdeckd"),
  };
}

/** `cargo build --release --locked --target <triple>` in flightdeckd/, copied to its
 *  dist path and ad-hoc signed (see the header for why the signature comes first). */
function buildDarwin(triple) {
  const { args, binary } = darwinBuild(triple);
  console.log(`· cargo ${args.join(" ")}`);
  execFileSync("cargo", args, { stdio: "inherit", cwd: FLIGHTDECKD_DIR });
  const out = distPathFor(triple);
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(binary, out);
  // --force replaces the linker's own ad-hoc signature (arm64) with a regular one; an
  // ad-hoc signature carries no certificate and no timestamp, so the bytes — and the
  // manifest's sha256 — are the same on every build of the same binary.
  execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", out], { stdio: "inherit" });
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const includePrebuilt = process.argv.includes("--include-prebuilt");
  // Asked only where it matters (a Mac building), before anything is built.
  const installed = !skipBuild && process.platform === "darwin" ? installedRustTargets() : null;
  const plan = planTargets(process.env.TARGETS, process.platform, installed);
  const built = [];

  if (!skipBuild) {
    for (const { triple, why } of plan.skipped) console.log(`· skipping ${triple}: ${why}`);
    if (plan.linux.length > 0) {
      console.log(`· running flightdeckd/scripts/build-musl.sh (${plan.linux.join(" ")}, needs Docker)`);
      execFileSync(path.join(FLIGHTDECKD_DIR, "scripts/build-musl.sh"), [], {
        stdio: "inherit",
        cwd: FLIGHTDECKD_DIR,
        env: { ...process.env, TARGETS: plan.linux.join(" ") },
      });
      built.push(...plan.linux);
    }
    for (const triple of plan.darwin) {
      buildDarwin(triple);
      built.push(triple);
    }
  } else {
    console.log(`· --skip-build: packaging whatever is already in ${DIST_DIR} and ${DARWIN_DIST_DIR}`);
  }

  const present = TARGET_TRIPLES.filter((t) => existsSync(distPathFor(t)));
  const packaged = selectPackaged({ built, present, skipBuild, includePrebuilt });
  if (packaged.length === 0) {
    console.error(`✗ no flightdeckd-<triple> binaries to package (looked in ${DIST_DIR} and ${DARWIN_DIST_DIR})`);
    process.exitCode = 1;
    return;
  }

  const version = readDaemonVersion(readFileSync(path.join(FLIGHTDECKD_DIR, "Cargo.toml"), "utf8"));
  const manifest = buildManifest(
    version,
    new Date().toISOString(),
    packaged.map((triple) => ({ triple, sha256: sha256File(distPathFor(triple)), size: statSync(distPathFor(triple)).size })),
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
  for (const triple of packaged) {
    copyFileSync(distPathFor(triple), path.join(RESOURCES_DIR, `flightdeckd-${triple}`));
  }
  writeFileSync(path.join(RESOURCES_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`✓ packaged ${packaged.length} binaries (${packaged.join(", ")}) into ${RESOURCES_DIR}`);
  console.log(`  version ${version}`);
  for (const [triple, t] of Object.entries(manifest.targets)) {
    console.log(`  ${triple}: ${t.size} bytes, sha256 ${t.sha256}`);
  }
  const absent = TARGET_TRIPLES.filter((t) => !packaged.includes(t));
  if (absent.length > 0) {
    console.log(`  not packaged: ${absent.join(", ")} — the app reports "no flightdeckd build" for those servers`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}
