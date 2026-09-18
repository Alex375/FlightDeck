// Self-test for scripts/build-daemon.mjs's pure pieces — Node's own test runner (no
// vitest: vitest.config.ts is deliberately scoped to "src/**" front-end tests, see its
// own header comment; this is a build script, not app code).
//
// Run: node --test scripts/build-daemon.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildManifest, readDaemonVersion, TARGET_TRIPLES } from "./build-daemon.mjs";

test("readDaemonVersion reads the [package] version line", () => {
  const cargoToml = ['[package]', 'name = "flightdeckd"', 'version = "0.2.0"', 'edition = "2021"', ""].join("\n");
  assert.equal(readDaemonVersion(cargoToml), "0.2.0");
});

test("readDaemonVersion throws when no version line is present", () => {
  assert.throws(() => readDaemonVersion('[package]\nname = "flightdeckd"\n'));
});

test("buildManifest shapes one entry per present target", () => {
  const manifest = buildManifest("0.2.0", "2026-09-18T00:00:00.000Z", [
    { triple: "x86_64-unknown-linux-musl", sha256: "aa", size: 10 },
    { triple: "aarch64-unknown-linux-musl", sha256: "bb", size: 11 },
  ]);
  assert.deepEqual(manifest, {
    version: "0.2.0",
    built_at: "2026-09-18T00:00:00.000Z",
    targets: {
      "x86_64-unknown-linux-musl": { sha256: "aa", size: 10 },
      "aarch64-unknown-linux-musl": { sha256: "bb", size: 11 },
    },
  });
});

test("buildManifest supports a partial (TARGETS=-limited) build — one entry only", () => {
  const manifest = buildManifest("0.2.0", "2026-09-18T00:00:00.000Z", [
    { triple: "aarch64-unknown-linux-musl", sha256: "bb", size: 11 },
  ]);
  assert.deepEqual(Object.keys(manifest.targets), ["aarch64-unknown-linux-musl"]);
});

test("TARGET_TRIPLES matches daemon_target_triple's two known arches (src-tauri/src/bootstrap/install.rs)", () => {
  assert.deepEqual(TARGET_TRIPLES, ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]);
});
