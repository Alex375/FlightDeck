// Self-test for scripts/updater-signature.mjs — Node's own test runner, like the other
// build-script tests (vitest.config.ts is scoped to the front end).
//
// Run: node --test scripts/updater-signature.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { KEY_A, KEY_B, PAYLOAD, PAYLOAD_SIGNATURE_BY_A } from "./updater-test-fixtures.mjs";
import {
  fileNameOfUrl,
  keyIdHex,
  parsePublicKey,
  parseSignature,
  pinnedPublicKey,
  UpdaterSignatureError,
  verifyManifest,
  verifyUpdaterSignature,
} from "./updater-signature.mjs";

/** Re-encodes a Tauri signature with one of its 4 lines replaced. */
function withLine(signatureB64, index, line) {
  const lines = Buffer.from(signatureB64, "base64").toString("utf8").split("\n");
  lines[index] = line;
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}

test("the app's pinned updater key is still BBE61E526D8E068F — changing it ends auto-update for every install", () => {
  assert.equal(keyIdHex(parsePublicKey(pinnedPublicKey()).keyId), "BBE61E526D8E068F");
});

test("a signature made by the Tauri CLI verifies against its key", () => {
  const result = verifyUpdaterSignature(PAYLOAD, PAYLOAD_SIGNATURE_BY_A, KEY_A.publicKey);
  assert.equal(result.keyId, KEY_A.id);
  assert.match(result.trustedComment, /^timestamp:\d+\tfile:payload\.txt$/);
  assert.equal(parseSignature(PAYLOAD_SIGNATURE_BY_A).prehashed, true);
});

test("one altered byte of the file fails", () => {
  const altered = Buffer.from(PAYLOAD);
  altered[0] ^= 1;
  assert.throws(() => verifyUpdaterSignature(altered, PAYLOAD_SIGNATURE_BY_A, KEY_A.publicKey), /does not match this file/);
});

test("a signature by another key names both keys", () => {
  assert.throws(
    () => verifyUpdaterSignature(PAYLOAD, PAYLOAD_SIGNATURE_BY_A, KEY_B.publicKey),
    (err) => err instanceof UpdaterSignatureError && err.message.includes(KEY_A.id) && err.message.includes(KEY_B.id),
  );
});

test("an edited trusted comment fails its global signature", () => {
  const forged = withLine(PAYLOAD_SIGNATURE_BY_A, 2, "trusted comment: timestamp:1\tfile:payload.txt");
  assert.throws(() => verifyUpdaterSignature(PAYLOAD, forged, KEY_A.publicKey), /global signature/);
});

test("the signature string is strict base64 — a trailing newline fails, as it fails the updater", () => {
  assert.throws(() => verifyUpdaterSignature(PAYLOAD, `${PAYLOAD_SIGNATURE_BY_A}\n`, KEY_A.publicKey), /strict base64/);
});

test("fileNameOfUrl takes the url's last segment, decoded", () => {
  assert.equal(
    fileNameOfUrl("https://github.com/o/r/releases/download/v1.0.0/Flight%20Deck_aarch64.app.tar.gz"),
    "Flight Deck_aarch64.app.tar.gz",
  );
});

test("verifyManifest reports every entry — good, mismatched and missing alike", () => {
  const base = "https://github.com/o/r/releases/download/v1.0.0";
  const files = { "good.tar.gz": PAYLOAD, "other.tar.gz": Buffer.from("not the payload") };
  const manifest = {
    platforms: {
      "darwin-aarch64": { url: `${base}/good.tar.gz`, signature: PAYLOAD_SIGNATURE_BY_A },
      "darwin-x86_64": { url: `${base}/other.tar.gz`, signature: PAYLOAD_SIGNATURE_BY_A },
      "linux-x86_64": { url: `${base}/absent.tar.gz`, signature: PAYLOAD_SIGNATURE_BY_A },
      "windows-x86_64": { url: `${base}/good.tar.gz` },
    },
  };
  const read = (p) => {
    const name = p.split("/").pop();
    if (!(name in files)) throw new Error(`ENOENT: ${name}`);
    return files[name];
  };
  const results = Object.fromEntries(verifyManifest(manifest, "/dir", KEY_A.publicKey, read).map((r) => [r.platform, r]));
  assert.equal(results["darwin-aarch64"].ok, true);
  assert.match(results["darwin-x86_64"].error, /does not match this file/);
  assert.match(results["linux-x86_64"].error, /ENOENT/);
  assert.match(results["windows-x86_64"].error, /no url or no signature/);
});
