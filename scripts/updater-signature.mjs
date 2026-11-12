// Updater signatures — checks a Tauri updater signature (a `.sig` file, or a `signature`
// field of latest.json) against the public key the shipped app pins
// (src-tauri/tauri.conf.json → plugins.updater.pubkey), the way the app's updater does
// before it installs anything: tauri-plugin-updater 2.10 decodes both strings as strict
// base64 and hands them to minisign-verify (key id, then the Ed25519 signature of the
// file — of its BLAKE2b-512 when "prehashed" — then the global signature over the
// trusted comment).
//
// Why it exists: the release signs its updater archives in a job of its own
// (.github/workflows/release.yml, `sign`). A key that is not the pair of the pinned one,
// a signature mangled on its way into latest.json, or an archive swapped after signing
// would each publish an update every installed app refuses — and an installed app has
// no way to learn a new key. `publish` runs this over latest.json before anything is
// released.
//
// Usage:
//   node scripts/updater-signature.mjs verify-manifest <latest.json> <dir>
//     → every platform of latest.json, against <dir>/<the file its url names>
//   node scripts/updater-signature.mjs verify <file> <file.sig>
//   Both take --config <tauri.conf.json> (default: src-tauri/tauri.conf.json).
//
// Self-test: node --test scripts/updater-signature.test.mjs (part of `pnpm test:scripts`).

import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));

const TRUSTED_PREFIX = "trusted comment: ";

export class UpdaterSignatureError extends Error {}

/** Strict base64, as the updater's decoders take it: standard alphabet, canonical
 *  padding, nothing around it — a trailing newline in latest.json fails the update. */
export function strictBase64(text, what) {
  if (typeof text !== "string" || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new UpdaterSignatureError(`${what} is not strict base64`);
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new UpdaterSignatureError(`${what} is not canonical base64`);
  return bytes;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Rust's `str::lines()`: split on \n, drop one trailing \r per line, no final empty line. */
function rustLines(text) {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function decodeBox(b64, what) {
  try {
    return rustLines(utf8.decode(strictBase64(b64, what)));
  } catch (err) {
    if (err instanceof UpdaterSignatureError) throw err;
    throw new UpdaterSignatureError(`${what} is not UTF-8 once decoded`);
  }
}

/** minisign prints a key id as the little-endian u64 it stores, in upper-case hex. */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

function algorithm(bytes, what) {
  const alg = bytes.subarray(0, 2).toString("latin1");
  if (alg !== "Ed" && alg !== "ED") throw new UpdaterSignatureError(`${what}: unsupported algorithm ${JSON.stringify(alg)}`);
  return alg;
}

/** The app's pinned key: base64 of a minisign public key file (comment line + key line). */
export function parsePublicKey(b64) {
  const lines = decodeBox(b64, "public key");
  if (lines.length < 2) throw new UpdaterSignatureError("public key: expected a comment line and a key line");
  const bin = strictBase64(lines[1], "public key line");
  if (bin.length !== 42) throw new UpdaterSignatureError(`public key: ${bin.length} bytes, expected 42`);
  algorithm(bin, "public key");
  return { keyId: bin.subarray(2, 10), key: bin.subarray(10, 42) };
}

/** A Tauri signature: base64 of a minisign signature file (4 lines). */
export function parseSignature(b64) {
  const lines = decodeBox(b64, "signature");
  if (lines.length < 4) throw new UpdaterSignatureError("signature: expected 4 lines");
  const bin = strictBase64(lines[1], "signature line");
  if (bin.length !== 74) throw new UpdaterSignatureError(`signature: ${bin.length} bytes, expected 74`);
  if (!lines[2].startsWith(TRUSTED_PREFIX)) throw new UpdaterSignatureError("signature: no trusted comment line");
  const globalSignature = strictBase64(lines[3], "global signature line");
  if (globalSignature.length !== 64) throw new UpdaterSignatureError(`global signature: ${globalSignature.length} bytes, expected 64`);
  return {
    prehashed: algorithm(bin, "signature") === "ED",
    keyId: bin.subarray(2, 10),
    signature: bin.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED_PREFIX.length),
    globalSignature,
  };
}

export function ed25519PublicKey(raw) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/**
 * Throws an UpdaterSignatureError saying what is wrong unless `signatureB64` is a valid
 * signature of `data` by the key `publicKeyB64` (both as Tauri writes them). Legacy
 * (non-prehashed) signatures are accepted, as the updater accepts them.
 */
export function verifyUpdaterSignature(data, signatureB64, publicKeyB64) {
  const pub = parsePublicKey(publicKeyB64);
  const sig = parseSignature(signatureB64);
  if (!pub.keyId.equals(sig.keyId)) {
    throw new UpdaterSignatureError(
      `signed by key ${keyIdHex(sig.keyId)}, but the app trusts key ${keyIdHex(pub.keyId)} — not the pinned key's pair`,
    );
  }
  const key = ed25519PublicKey(pub.key);
  const message = sig.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!ed25519Verify(null, message, key, sig.signature)) {
    throw new UpdaterSignatureError("the signature does not match this file (altered or another file)");
  }
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519Verify(null, global, key, sig.globalSignature)) {
    throw new UpdaterSignatureError("the trusted comment does not match its global signature");
  }
  return { keyId: keyIdHex(sig.keyId), trustedComment: sig.trustedComment };
}

export function pinnedPublicKey(configPath = DEFAULT_CONFIG) {
  const pubkey = JSON.parse(readFileSync(configPath, "utf8")).plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || !pubkey) throw new UpdaterSignatureError(`${configPath} has no plugins.updater.pubkey`);
  return pubkey;
}

/** The file a latest.json url points at, as named in the release (last path segment). */
export function fileNameOfUrl(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

/**
 * Checks every platform entry of a latest.json against the files in `dir`. Returns one
 * result per entry ({platform, file, ok, error?, trustedComment?}); never throws for a
 * bad entry, so one run reports them all.
 */
export function verifyManifest(manifest, dir, publicKeyB64, readFile = (p) => readFileSync(p)) {
  const entries = Object.entries(manifest?.platforms ?? {});
  const cache = new Map();
  return entries.map(([platform, entry]) => {
    let file = "";
    try {
      if (typeof entry?.url !== "string" || typeof entry?.signature !== "string") {
        throw new UpdaterSignatureError("entry has no url or no signature");
      }
      file = fileNameOfUrl(entry.url);
      if (!cache.has(file)) cache.set(file, readFile(path.join(dir, file)));
      const { trustedComment } = verifyUpdaterSignature(cache.get(file), entry.signature, publicKeyB64);
      return { platform, file, ok: true, trustedComment };
    } catch (err) {
      return { platform, file, ok: false, error: err.message };
    }
  });
}

function parseArgs(argv) {
  const positional = [];
  let config = DEFAULT_CONFIG;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") config = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, config };
}

function main(argv) {
  const [mode, ...rest] = argv;
  const { positional, config } = parseArgs(rest);
  const pubkey = pinnedPublicKey(config);
  const pinnedId = keyIdHex(parsePublicKey(pubkey).keyId);
  if (mode === "verify-manifest" && positional.length === 2) {
    const [manifestPath, dir] = positional;
    const results = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), dir, pubkey);
    if (results.length === 0) {
      console.error(`::error::${manifestPath} lists no platform`);
      return 1;
    }
    for (const r of results) {
      if (r.ok) console.log(`✓ ${r.platform}: ${r.file} — signed by the pinned key ${pinnedId} (${r.trustedComment})`);
      else console.error(`::error::${r.platform}${r.file ? ` (${r.file})` : ""}: ${r.error}`);
    }
    return results.every((r) => r.ok) ? 0 : 1;
  }
  if (mode === "verify" && positional.length === 2) {
    const [file, sigFile] = positional;
    try {
      // Trimmed as latest.json's assembly trims it (release.yml).
      const signature = readFileSync(sigFile, "utf8").trimEnd();
      const { trustedComment } = verifyUpdaterSignature(readFileSync(file), signature, pubkey);
      console.log(`✓ ${file} — signed by the pinned key ${pinnedId} (${trustedComment})`);
      return 0;
    } catch (err) {
      if (!(err instanceof UpdaterSignatureError)) throw err;
      console.error(`::error::${file}: ${err.message}`);
      return 1;
    }
  }
  console.error("usage: updater-signature.mjs verify-manifest <latest.json> <dir> | verify <file> <file.sig>  [--config <tauri.conf.json>]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
