// Self-test for scripts/updater-key.mjs — Node's own test runner, like the other
// build-script tests. The last test drives the repo's Tauri CLI (node_modules), the very
// tool the release signs with: it is what proves a re-encrypted key is one Tauri accepts.
//
// Run: node --test scripts/updater-key.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { KEY_A, KEY_B } from "./updater-test-fixtures.mjs";
import {
  cryptBlock,
  encodeSecretKeyFile,
  openPinnedKey,
  parseSecretKeyFile,
  scryptParams,
  signWithTauriCli,
  UpdaterKeyError,
  withPassphrase,
  writeVerified,
} from "./updater-key.mjs";

const SCRIPT = fileURLToPath(new URL("./updater-key.mjs", import.meta.url));

/** A scratch dir holding key A's file and a config that pins key A. */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "updater-key-cli-"));
  writeFileSync(path.join(dir, "a.key"), KEY_A.privateKey);
  writeFileSync(path.join(dir, "conf.json"), JSON.stringify({ plugins: { updater: { pubkey: KEY_A.publicKey } } }));
  return dir;
}

/** Runs the CLI with stdin NOT a terminal and only the given UPDATER_KEY_* variables. */
function cli(dir, args, env = {}) {
  const base = { ...process.env };
  delete base.UPDATER_KEY_PASSPHRASE;
  delete base.UPDATER_KEY_NEW_PASSPHRASE;
  return spawnSync(process.execPath, [SCRIPT, ...args, "--config", path.join(dir, "conf.json")], {
    env: { ...base, ...env },
    input: "",
    encoding: "utf8",
  });
}

test("a key file parses and re-encodes byte for byte", () => {
  const key = parseSecretKeyFile(KEY_A.privateKey);
  assert.equal(key.kdfAlg, "Sc");
  assert.equal(encodeSecretKeyFile(key), KEY_A.privateKey);
});

test("scryptParams matches libsodium's pickparams (Tauri's limits, then libsodium's interactive and sensitive)", () => {
  assert.deepEqual(scryptParams(1048576n, 33554432n), { N: 2 ** 15, r: 8, p: 1 });
  assert.deepEqual(scryptParams(524288n, 16777216n), { N: 2 ** 14, r: 8, p: 1 });
  assert.deepEqual(scryptParams(33554432n, 1073741824n), { N: 2 ** 20, r: 8, p: 1 });
});

test("a key generated without a passphrase opens with the empty one, into its own public key", () => {
  openPinnedKey(parseSecretKeyFile(KEY_A.privateKey), "", KEY_A.publicKey);
});

test("a wrong passphrase is told apart from another key", () => {
  assert.throws(() => openPinnedKey(parseSecretKeyFile(KEY_A.privateKey), "nope", KEY_A.publicKey), /wrong passphrase/);
  assert.throws(
    () => openPinnedKey(parseSecretKeyFile(KEY_B.privateKey), "", KEY_A.publicKey),
    (err) => err.message.includes(`this is key ${KEY_B.id}`) && err.message.includes(`pins key ${KEY_A.id}`),
  );
});

test("withPassphrase keeps the key and changes only salt and encryption", () => {
  const key = parseSecretKeyFile(KEY_A.privateKey);
  const clear = openPinnedKey(key, "", KEY_A.publicKey);
  const next = withPassphrase(key, clear, "correct horse battery staple");
  assert.notDeepEqual(next.salt, key.salt);
  assert.notDeepEqual(next.block, key.block);
  assert.deepEqual(cryptBlock(next, "correct horse battery staple"), clear);
  openPinnedKey(parseSecretKeyFile(encodeSecretKeyFile(next)), "correct horse battery staple", KEY_A.publicKey);
  assert.throws(() => openPinnedKey(next, "", KEY_A.publicKey), /wrong passphrase/);
  assert.throws(() => withPassphrase(key, clear, ""), /empty/);
});

test("the Tauri CLI signs with a re-encrypted key, and only with its new passphrase", () => {
  const key = parseSecretKeyFile(KEY_A.privateKey);
  const next = withPassphrase(key, openPinnedKey(key, "", KEY_A.publicKey), "a new passphrase ✈");
  const dir = mkdtempSync(path.join(tmpdir(), "updater-key-test-"));
  try {
    const file = path.join(dir, "a-with-passphrase.key");
    writeFileSync(file, encodeSecretKeyFile(next));
    assert.match(signWithTauriCli(file, "a new passphrase ✈", KEY_A.publicKey), /^timestamp:\d+\tfile:probe\.bin$/);
    assert.throws(() => signWithTauriCli(file, "", KEY_A.publicKey), /refused the new key \(exit \d+\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeVerified creates the file only once its check passed, and never leaves a temporary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "updater-key-write-"));
  try {
    const to = path.join(dir, "new.key");
    assert.throws(() => writeVerified(to, "x", () => { throw new UpdaterKeyError("refused"); }), /refused/);
    assert.equal(existsSync(to), false);
    assert.deepEqual(readdirSync(dir), []);

    assert.equal(writeVerified(to, "content", (temp) => readFileSync(temp, "utf8")), "content");
    assert.equal(readFileSync(to, "utf8"), "content");
    assert.equal(statSync(to).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["new.key"]);

    // A file that appears at `to` while the check runs is never overwritten.
    const other = path.join(dir, "other.key");
    assert.throws(() => writeVerified(other, "mine", () => writeFileSync(other, "theirs")), /appeared meanwhile/);
    assert.equal(readFileSync(other, "utf8"), "theirs");
    assert.deepEqual(readdirSync(dir).sort(), ["new.key", "other.key"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripted set-passphrase: a 0600 key that opens with the new passphrase only", () => {
  const dir = sandbox();
  try {
    const out = path.join(dir, "a-pass.key");
    const run = cli(dir, ["set-passphrase", path.join(dir, "a.key"), out], {
      UPDATER_KEY_PASSPHRASE: "",
      UPDATER_KEY_NEW_PASSPHRASE: "scripted ✈ pass",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`the same key ${KEY_A.id}`));
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ["a-pass.key", "a.key", "conf.json"]);
    assert.equal(cli(dir, ["check", out], { UPDATER_KEY_PASSPHRASE: "scripted ✈ pass" }).status, 0);
    const empty = cli(dir, ["check", out], { UPDATER_KEY_PASSPHRASE: "" });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /wrong passphrase/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set-passphrase refusals leave no file: existing target, wrong current passphrase, no terminal", () => {
  const dir = sandbox();
  try {
    const from = path.join(dir, "a.key");
    const taken = path.join(dir, "taken.key");
    writeFileSync(taken, "keep me");
    const exists = cli(dir, ["set-passphrase", from, taken], { UPDATER_KEY_PASSPHRASE: "", UPDATER_KEY_NEW_PASSPHRASE: "p" });
    assert.equal(exists.status, 1);
    assert.match(exists.stderr, /already exists/);
    assert.equal(readFileSync(taken, "utf8"), "keep me");

    const wrong = cli(dir, ["set-passphrase", from, path.join(dir, "n1.key")], { UPDATER_KEY_PASSPHRASE: "nope", UPDATER_KEY_NEW_PASSPHRASE: "p" });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /wrong passphrase/);

    const noTty = cli(dir, ["set-passphrase", from, path.join(dir, "n2.key")], { UPDATER_KEY_PASSPHRASE: "" });
    assert.equal(noTty.status, 1);
    assert.match(noTty.stderr, /run this in a terminal/);

    assert.deepEqual(readdirSync(dir).sort(), ["a.key", "conf.json", "taken.key"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check against the pinned key refuses another key", () => {
  const dir = sandbox();
  try {
    writeFileSync(path.join(dir, "b.key"), KEY_B.privateKey);
    const run = cli(dir, ["check", path.join(dir, "b.key")], { UPDATER_KEY_PASSPHRASE: "" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`this is key ${KEY_B.id}, but the app pins key ${KEY_A.id}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
