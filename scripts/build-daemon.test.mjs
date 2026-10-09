// Self-test for scripts/build-daemon.mjs's pure pieces — Node's own test runner (no
// vitest: vitest.config.ts is deliberately scoped to "src/**" front-end tests, see its
// own header comment; this is a build script, not app code).
//
// Run: node --test scripts/build-daemon.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  buildManifest,
  DARWIN_DIST_DIR,
  DARWIN_TRIPLES,
  darwinBuild,
  DIST_DIR,
  distPathFor,
  FLIGHTDECKD_DIR,
  installedRustTargets,
  isDarwinTriple,
  LINUX_TRIPLES,
  planTargets,
  readDaemonVersion,
  selectPackaged,
  TARGET_TRIPLES,
} from "./build-daemon.mjs";

test("readDaemonVersion reads the [package] version line", () => {
  const cargoToml = ['[package]', 'name = "flightdeckd"', 'version = "0.3.0"', 'edition = "2021"', ""].join("\n");
  assert.equal(readDaemonVersion(cargoToml), "0.3.0");
});

test("readDaemonVersion throws when no version line is present", () => {
  assert.throws(() => readDaemonVersion('[package]\nname = "flightdeckd"\n'));
});

test("buildManifest shapes one entry per packaged target — Linux and macOS alike", () => {
  const manifest = buildManifest("0.3.0", "2026-10-09T00:00:00.000Z", [
    { triple: "x86_64-unknown-linux-musl", sha256: "aa", size: 10 },
    { triple: "aarch64-unknown-linux-musl", sha256: "bb", size: 11 },
    { triple: "x86_64-apple-darwin", sha256: "cc", size: 12 },
    { triple: "aarch64-apple-darwin", sha256: "dd", size: 13 },
  ]);
  assert.deepEqual(manifest, {
    version: "0.3.0",
    built_at: "2026-10-09T00:00:00.000Z",
    targets: {
      "x86_64-unknown-linux-musl": { sha256: "aa", size: 10 },
      "aarch64-unknown-linux-musl": { sha256: "bb", size: 11 },
      "x86_64-apple-darwin": { sha256: "cc", size: 12 },
      "aarch64-apple-darwin": { sha256: "dd", size: 13 },
    },
  });
});

test("buildManifest supports a partial (TARGETS=-limited) build — one entry only", () => {
  const manifest = buildManifest("0.3.0", "2026-10-09T00:00:00.000Z", [
    { triple: "aarch64-unknown-linux-musl", sha256: "bb", size: 11 },
  ]);
  assert.deepEqual(Object.keys(manifest.targets), ["aarch64-unknown-linux-musl"]);
});

test("TARGET_TRIPLES lists daemon_target_triple's four platforms (src-tauri/src/bootstrap/install.rs)", () => {
  // The Rust test `bundled_triples_match_build_daemon_mjs` pins the same list from the
  // other side.
  assert.deepEqual(TARGET_TRIPLES, [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
  ]);
  assert.deepEqual(LINUX_TRIPLES, ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]);
  assert.deepEqual(DARWIN_TRIPLES, ["x86_64-apple-darwin", "aarch64-apple-darwin"]);
  assert.equal(isDarwinTriple("aarch64-apple-darwin"), true);
  assert.equal(isDarwinTriple("aarch64-unknown-linux-musl"), false);
});

test("distPathFor keeps the musl and macOS builds in their own dist dirs", () => {
  assert.equal(distPathFor("x86_64-unknown-linux-musl"), path.join(DIST_DIR, "flightdeckd-x86_64-unknown-linux-musl"));
  assert.equal(distPathFor("x86_64-apple-darwin"), path.join(DARWIN_DIST_DIR, "flightdeckd-x86_64-apple-darwin"));
});

test("planTargets: the default builds Linux everywhere, and the macOS ones only on a Mac", () => {
  const offMac = planTargets(undefined, "linux");
  assert.deepEqual([offMac.linux, offMac.darwin], [LINUX_TRIPLES, []]);
  assert.deepEqual(offMac.skipped.map((s) => s.triple), DARWIN_TRIPLES);
  assert.match(offMac.skipped[0].why, /only be built on a Mac/);
  assert.deepEqual(planTargets("", "darwin", [...DARWIN_TRIPLES, "x86_64-unknown-linux-musl"]), {
    linux: LINUX_TRIPLES,
    darwin: DARWIN_TRIPLES,
    skipped: [],
  });
  assert.deepEqual(planTargets("  ", "linux").darwin, []);
});

// Review: the default used to plan both macOS triples on any Mac, so an Intel Mac without
// `aarch64-apple-darwin` (or cargo without rustup) ran the whole Docker build, then
// failed on cargo and packaged nothing — not even the fresh Linux binaries.
test("planTargets: a default run on a Mac skips, up front and saying how to add it, a macOS target its toolchain lacks", () => {
  const intel = planTargets(undefined, "darwin", ["x86_64-apple-darwin"]);
  assert.deepEqual(intel.linux, LINUX_TRIPLES);
  assert.deepEqual(intel.darwin, ["x86_64-apple-darwin"]);
  assert.deepEqual(intel.skipped, [
    { triple: "aarch64-apple-darwin", why: "its Rust target isn't installed — rustup target add aarch64-apple-darwin" },
  ]);
  const noToolchain = planTargets(undefined, "darwin", null);
  assert.deepEqual([noToolchain.linux, noToolchain.darwin], [LINUX_TRIPLES, []]);
  assert.deepEqual(noToolchain.skipped.map((s) => s.triple), DARWIN_TRIPLES);
  assert.match(noToolchain.skipped[0].why, /no Rust toolchain/);
});

test("planTargets: an explicit list builds exactly those, comma or space separated", () => {
  assert.deepEqual(planTargets("aarch64-unknown-linux-musl", "linux"), {
    linux: ["aarch64-unknown-linux-musl"],
    darwin: [],
    skipped: [],
  });
  assert.deepEqual(planTargets("aarch64-apple-darwin,x86_64-apple-darwin", "darwin", DARWIN_TRIPLES), {
    linux: [],
    darwin: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
    skipped: [],
  });
  // No toolchain answered: the request stands, and cargo itself says what is wrong.
  assert.deepEqual(planTargets("x86_64-apple-darwin", "darwin", null).darwin, ["x86_64-apple-darwin"]);
});

test("planTargets refuses what can't be built — never a silent skip", () => {
  assert.throws(() => planTargets("x86_64-apple-darwin", "linux"), /only be built on a Mac/);
  assert.throws(() => planTargets("riscv64gc-unknown-linux-gnu", "linux"), /unknown target triple/);
  assert.throws(
    () => planTargets("x86_64-apple-darwin aarch64-apple-darwin", "darwin", ["x86_64-apple-darwin"]),
    /rustup target add aarch64-apple-darwin/,
  );
});

test("installedRustTargets: rustup's list, else rustc's host target, else null", () => {
  const fail = () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
  const rustup = (cmd) => (cmd === "rustup" ? "x86_64-apple-darwin\naarch64-apple-darwin\n" : fail());
  assert.deepEqual(installedRustTargets(rustup), ["x86_64-apple-darwin", "aarch64-apple-darwin"]);
  const rustcOnly = (cmd) => (cmd === "rustc" ? "rustc 1.90.0\nbinary: rustc\nhost: x86_64-apple-darwin\n" : fail());
  assert.deepEqual(installedRustTargets(rustcOnly), ["x86_64-apple-darwin"]);
  assert.equal(installedRustTargets(fail), null);
});

// Review: the copy read flightdeckd/target/<triple>/… while an exported CARGO_TARGET_DIR
// sent cargo's output elsewhere — ENOENT right after a successful build.
test("darwinBuild pins cargo's output under flightdeckd/target, where the copy reads it", () => {
  const { args, binary } = darwinBuild("x86_64-apple-darwin");
  assert.deepEqual(args.slice(0, 5), ["build", "--release", "--locked", "--target", "x86_64-apple-darwin"]);
  assert.equal(args[args.indexOf("--target-dir") + 1], path.join(FLIGHTDECKD_DIR, "target"));
  assert.equal(binary, path.join(FLIGHTDECKD_DIR, "target", "x86_64-apple-darwin", "release/flightdeckd"));
});

test("selectPackaged: a build packages what it built, never a leftover from an earlier run", () => {
  const present = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin"];
  assert.deepEqual(
    selectPackaged({ built: ["aarch64-unknown-linux-musl"], present, skipBuild: false, includePrebuilt: false }),
    ["aarch64-unknown-linux-musl"],
  );
});

test("selectPackaged: --include-prebuilt adds what's already there (the release's macOS job)", () => {
  const present = [...TARGET_TRIPLES];
  assert.deepEqual(
    selectPackaged({ built: [...DARWIN_TRIPLES], present, skipBuild: false, includePrebuilt: true }),
    TARGET_TRIPLES,
  );
});

test("selectPackaged: --skip-build packages everything present", () => {
  assert.deepEqual(
    selectPackaged({ built: [], present: ["aarch64-apple-darwin", "x86_64-unknown-linux-musl"], skipBuild: true, includePrebuilt: false }),
    ["x86_64-unknown-linux-musl", "aarch64-apple-darwin"],
  );
});

test("selectPackaged: a built target whose binary is missing is an error, not a smaller manifest", () => {
  assert.throws(
    () => selectPackaged({ built: ["x86_64-apple-darwin"], present: [], skipBuild: false, includePrebuilt: false }),
    /built but missing/,
  );
});
