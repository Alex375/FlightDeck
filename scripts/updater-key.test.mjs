// Self-test for scripts/updater-key.mjs — Node's own test runner, like the other
// build-script tests. The last test drives the repo's Tauri CLI (node_modules), the very
// tool the release signs with: it is what proves a re-encrypted key is one Tauri accepts.
//
// Run: node --test scripts/updater-key.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KEY_A, KEY_B } from "./updater-test-fixtures.mjs";
import {
  cryptBlock,
  encodeSecretKeyFile,
  openPinnedKey,
  parseSecretKeyFile,
  scryptParams,
  signWithTauriCli,
  withPassphrase,
} from "./updater-key.mjs";

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
    assert.throws(() => signWithTauriCli(file, "", KEY_A.publicKey), /refused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
