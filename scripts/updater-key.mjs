// Updater signing key — puts a passphrase on (or changes the passphrase of) the private
// key that signs Flight Deck's updates, WITHOUT changing the key pair: the public key is
// pinned in every installed app (src-tauri/tauri.conf.json → plugins.updater.pubkey) and
// a new pair would end auto-update for all of them.
//
// The key file is what `tauri signer generate` writes (and what the
// TAURI_SIGNING_PRIVATE_KEY secret holds): base64 of a minisign secret key, whose 104-byte
// key block is XORed with scrypt(passphrase, salt) — "encrypted" with an empty passphrase
// when generated without one. Re-encrypting = decrypt with the current passphrase,
// re-XOR with a fresh salt and the new one; the key itself and its checksum are untouched.
//
// Usage (on the machine holding the key; prompts without echo):
//   node scripts/updater-key.mjs set-passphrase <current key file> <new key file>
//     → refuses unless the current file opens into the key the app pins; writes the new
//       file (never over an existing one), then has the Tauri CLI sign with it and checks
//       that signature against the pinned key — the release's own path end to end.
//   node scripts/updater-key.mjs check <key file>
//     → does this file + passphrase open into the pinned key? (a backup, a secret to upload)
//
// Then (see .github/workflows/release.yml, job `sign`): upload the new file and the
// passphrase to the GitHub Environment `updater-signing`, and keep both backed up — the
// key file alone no longer signs anything.
//
// Self-test: node --test scripts/updater-key.test.mjs (part of `pnpm test:scripts`).

import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, scryptSync, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONFIG,
  ed25519PublicKey,
  keyIdHex,
  parsePublicKey,
  pinnedPublicKey,
  strictBase64,
  verifyUpdaterSignature,
} from "./updater-signature.mjs";

const KEY_BLOCK_LEN = 104; // keynum (8) + secret key (64: seed + public key) + checksum (32)
const SECRET_KEY_LEN = 158;

export class UpdaterKeyError extends Error {}

/** A key file → its fields. `block` is the key block AS STORED (encrypted unless kdf is "none"). */
export function parseSecretKeyFile(fileText) {
  let lines;
  try {
    lines = Buffer.from(strictBase64(fileText.trim(), "key file")).toString("utf8").split("\n");
  } catch (err) {
    throw new UpdaterKeyError(`not a Tauri private key file: ${err.message}`);
  }
  if (lines.length < 2) throw new UpdaterKeyError("not a Tauri private key file: expected a comment line and a key line");
  const bin = Buffer.from(lines[1].replace(/\r$/, ""), "base64");
  if (bin.length !== SECRET_KEY_LEN) throw new UpdaterKeyError(`not a minisign secret key: ${bin.length} bytes, expected ${SECRET_KEY_LEN}`);
  const field = (from, to) => bin.subarray(from, to).toString("latin1");
  const key = {
    comment: lines[0],
    sigAlg: field(0, 2),
    kdfAlg: field(2, 4),
    chkAlg: field(4, 6),
    salt: Buffer.from(bin.subarray(6, 38)),
    opslimit: bin.readBigUInt64LE(38),
    memlimit: bin.readBigUInt64LE(46),
    block: Buffer.from(bin.subarray(54, 158)),
  };
  if (key.sigAlg !== "Ed" || key.chkAlg !== "B2") throw new UpdaterKeyError(`unsupported key algorithms ${JSON.stringify(key.sigAlg + key.chkAlg)}`);
  if (key.kdfAlg !== "Sc" && key.kdfAlg !== "\0\0") throw new UpdaterKeyError(`unsupported key derivation ${JSON.stringify(key.kdfAlg)}`);
  return key;
}

/** Fields → a key file's text, as `tauri signer generate` writes it (no trailing newline). */
export function encodeSecretKeyFile(key) {
  const bin = Buffer.alloc(SECRET_KEY_LEN);
  bin.write(key.sigAlg, 0, "latin1");
  bin.write(key.kdfAlg, 2, "latin1");
  bin.write(key.chkAlg, 4, "latin1");
  key.salt.copy(bin, 6);
  bin.writeBigUInt64LE(key.opslimit, 38);
  bin.writeBigUInt64LE(key.memlimit, 46);
  key.block.copy(bin, 54);
  return Buffer.from(`${key.comment}\n${bin.toString("base64")}\n`, "utf8").toString("base64");
}

/** libsodium's scryptsalsa208sha256 limits → scrypt N/r/p (its `pickparams`, which the
 *  minisign crate ports as `raw_scrypt_params`). */
export function scryptParams(opslimit, memlimit) {
  const ops = opslimit < 32768n ? 32768n : opslimit;
  const r = 8n;
  let nLog2 = 1n;
  let p;
  const fit = (maxN) => {
    while (nLog2 < 63n && !(1n << nLog2 > maxN / 2n)) nLog2 += 1n;
  };
  if (ops < memlimit / 32n) {
    p = 1n;
    fit(ops / (r * 4n));
  } else {
    fit(memlimit / (r * 128n));
    let maxrp = ops / 4n / (1n << nLog2);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  return { N: Number(1n << nLog2), r: Number(r), p: Number(p) };
}

/** XORs the key block with scrypt(passphrase) — decrypts an encrypted block, encrypts a clear one. */
export function cryptBlock(key, passphrase) {
  if (key.kdfAlg === "\0\0") return Buffer.from(key.block);
  const { N, r, p } = scryptParams(key.opslimit, key.memlimit);
  const stream = scryptSync(Buffer.from(passphrase, "utf8"), key.salt, KEY_BLOCK_LEN, { N, r, p, maxmem: 256 * N * r * p + 1024 * 1024 });
  const out = Buffer.alloc(KEY_BLOCK_LEN);
  for (let i = 0; i < KEY_BLOCK_LEN; i++) out[i] = key.block[i] ^ stream[i];
  return out;
}

/** The public key the block's seed actually derives (empty when it is not a valid seed). */
function derivedPublicKey(seed, claimedPublic) {
  try {
    const priv = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: claimedPublic.toString("base64url") },
      format: "jwk",
    });
    return Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Opens `key` with `passphrase` and checks it is the pair of `pinnedB64` (the app's
 * pubkey). Returns the decrypted block; throws an UpdaterKeyError telling a wrong
 * passphrase from another key.
 */
export function openPinnedKey(key, passphrase, pinnedB64) {
  const pinned = parsePublicKey(pinnedB64);
  const clear = cryptBlock(key, passphrase);
  const keyId = clear.subarray(0, 8);
  const seed = clear.subarray(8, 40);
  const claimedPublic = clear.subarray(40, 72);
  // A wrong passphrase yields noise: a seed that does not derive the public half next to it.
  if (!derivedPublicKey(seed, claimedPublic).equals(claimedPublic)) {
    throw new UpdaterKeyError(
      key.kdfAlg === "\0\0" ? "this key file is corrupt (its secret half does not derive its public half)" : "wrong passphrase for this key file",
    );
  }
  if (!keyId.equals(pinned.keyId) || !claimedPublic.equals(pinned.key)) {
    throw new UpdaterKeyError(`this is key ${keyIdHex(keyId)}, but the app pins key ${keyIdHex(pinned.keyId)} — not the updater key`);
  }
  // Belt and braces: a signature by this seed verifies under the PINNED key.
  const priv = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: claimedPublic.toString("base64url") },
    format: "jwk",
  });
  const probe = Buffer.from("flight-deck updater key check");
  if (!ed25519Verify(null, probe, ed25519PublicKey(pinned.key), ed25519Sign(null, probe, priv))) {
    throw new UpdaterKeyError("this key does not sign for the pinned public key");
  }
  return clear;
}

/** The same key under a new passphrase (fresh salt, same KDF limits). */
export function withPassphrase(key, clearBlock, newPassphrase) {
  if (!newPassphrase) throw new UpdaterKeyError("the new passphrase is empty");
  const next = { ...key, kdfAlg: "Sc", salt: randomBytes(32), block: clearBlock };
  if (key.kdfAlg === "\0\0") {
    // An unencrypted key carries no limits worth keeping: take `tauri signer generate`'s.
    next.opslimit = 1048576n;
    next.memlimit = 33554432n;
  }
  return { ...next, block: cryptBlock(next, newPassphrase) };
}

/** Prompts on the terminal without echoing what is typed. */
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new UpdaterKeyError("run this in a terminal: it reads passphrases without echoing them"));
      return;
    }
    process.stderr.write(label);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    let value = "";
    const finish = (err) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new UpdaterKeyError("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** Signs a scratch file with the repo's Tauri CLI and the given key, then checks that
 *  signature against the pinned key — what the release's `sign` + `publish` jobs do. */
export function signWithTauriCli(keyFile, passphrase, pinnedB64) {
  const cli = fileURLToPath(new URL("../node_modules/.bin/tauri", import.meta.url));
  if (!existsSync(cli)) throw new UpdaterKeyError(`${cli} is missing — run \`pnpm install\` first`);
  const dir = mkdtempSync(path.join(tmpdir(), "updater-key-"));
  try {
    const file = path.join(dir, "probe.bin");
    writeFileSync(file, randomBytes(4096));
    // The passphrase through the environment, never argv (visible to `ps`); no other key
    // source the CLI could prefer over the file.
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: passphrase };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    const run = spawnSync(cli, ["signer", "sign", "-f", keyFile, file], { env, encoding: "utf8" });
    if (run.status !== 0) throw new UpdaterKeyError(`the Tauri CLI refused the new key:\n${run.stderr || run.stdout}`);
    const { trustedComment } = verifyUpdaterSignature(readFileSync(file), readFileSync(`${file}.sig`, "utf8").trimEnd(), pinnedB64);
    return trustedComment;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const [mode, ...positional] = argv;
  const pinned = pinnedPublicKey(DEFAULT_CONFIG);
  const pinnedId = keyIdHex(parsePublicKey(pinned).keyId);
  if (mode === "check" && positional.length === 1) {
    const key = parseSecretKeyFile(readFileSync(positional[0], "utf8"));
    const passphrase = key.kdfAlg === "\0\0" ? "" : await promptHidden("Passphrase (Enter if none): ");
    openPinnedKey(key, passphrase, pinned);
    console.log(`✓ ${positional[0]} opens into the pinned updater key ${pinnedId}${passphrase ? "" : " — WITHOUT a passphrase"}.`);
    return 0;
  }
  if (mode === "set-passphrase" && positional.length === 2) {
    const [from, to] = positional;
    if (existsSync(to)) throw new UpdaterKeyError(`${to} already exists — pick a new path, nothing is overwritten`);
    const key = parseSecretKeyFile(readFileSync(from, "utf8"));
    const current = key.kdfAlg === "\0\0" ? "" : await promptHidden("Current passphrase (Enter if none): ");
    const clear = openPinnedKey(key, current, pinned);
    console.log(`✓ ${from} opens into the pinned updater key ${pinnedId}.`);
    const next = await promptHidden("New passphrase: ");
    if (!next) throw new UpdaterKeyError("the new passphrase is empty");
    if ((await promptHidden("New passphrase again: ")) !== next) throw new UpdaterKeyError("the two passphrases differ");
    if (next === current) throw new UpdaterKeyError("the new passphrase is the current one");
    const updated = withPassphrase(key, clear, next);
    openPinnedKey(updated, next, pinned);
    writeFileSync(to, encodeSecretKeyFile(updated), { flag: "wx", mode: 0o600 });
    const comment = signWithTauriCli(to, next, pinned);
    console.log(`✓ ${to} written: the same key ${pinnedId}, under the new passphrase.`);
    console.log(`✓ The Tauri CLI signs with it, and the signature verifies against the pinned key (${comment}).`);
    console.log("\nNext — see .github/workflows/release.yml, job `sign`:");
    console.log(`  gh secret set TAURI_SIGNING_PRIVATE_KEY --env updater-signing < ${JSON.stringify(to)}`);
    console.log("  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env updater-signing   # paste the passphrase");
    console.log(`Back up ${to} AND the passphrase: the key file alone no longer signs anything.`);
    return 0;
  }
  console.error("usage: updater-key.mjs set-passphrase <current key file> <new key file> | check <key file>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UpdaterKeyError)) throw err;
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
