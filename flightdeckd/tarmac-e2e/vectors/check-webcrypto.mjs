// Replays vectors/handshake-v1.json with WebCrypto, the API the Tarmac PWA uses
// (Safari and Node expose the same `crypto.subtle`). Every derived value of the
// Rust implementation must come out identical, byte for byte. This is the phone
// side of docs/tarmac-sealed-channel.md, written as the PWA will write it.
//
//   node flightdeckd/tarmac-e2e/vectors/check-webcrypto.mjs
//
// Exits non-zero on the first mismatch.

import { readFile } from "node:fs/promises";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const v = JSON.parse(await readFile(new URL("./handshake-v1.json", import.meta.url), "utf8"));

const b64 = {
  decode(s) {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  },
  encode(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const lp = (bytes) => concat(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

async function hkdf(ikm, salt, info, bytes) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function check(what, got, want) {
  if (got !== want) {
    console.error(`✗ ${what}\n  got  ${got}\n  want ${want}`);
    process.exit(1);
  }
  console.log(`✓ ${what}`);
}

// §3 — the phone derives this node's key from the QR secret.
const secret = b64.decode(v.device_secret);
const nodeKey = await hkdf(secret, enc.encode(v.label), concat(enc.encode("node:"), enc.encode(v.mac_id)), 32);
check("K_node", b64.encode(nodeKey), v.node_key);

// §4 — the phone's ephemeral (fixed here; a real phone uses generateKey).
const phonePub = b64.decode(v.hello.e);
const phonePriv = await subtle.importKey(
  "jwk",
  { kty: "EC", crv: "P-256", d: v.phone_ephemeral_private,
    x: b64.encode(phonePub.slice(1, 33)), y: b64.encode(phonePub.slice(33, 65)) },
  { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
);
const nodePub = await subtle.importKey("raw", b64.decode(v.accept.e), { name: "ECDH", namedCurve: "P-256" }, false, []);
const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: nodePub }, phonePriv, 256));

const th = new Uint8Array(await subtle.digest("SHA-256", concat(
  lp(enc.encode(v.label)), lp(enc.encode(v.mac_id)), lp(b64.decode(v.hello.d)), lp(u32be(v.hello.g)),
  lp(phonePub), lp(b64.decode(v.hello.n)), lp(b64.decode(v.accept.e)), lp(b64.decode(v.accept.n)),
)));
const okm = await hkdf(shared, nodeKey, concat(enc.encode("keys"), th), 96);
const [kUp, kDown, kConf] = [okm.slice(0, 32), okm.slice(32, 64), okm.slice(64, 96)];

const hmacKey = await subtle.importKey("raw", kConf, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
const proofOk = await subtle.verify("HMAC", hmacKey, b64.decode(v.accept.p), concat(enc.encode("node-accept"), th));
check("node proof verifies", String(proofOk), "true");

// §5 — sealed frames.
const nonce = (n) => { const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, BigInt(n)); return iv; };
const aesUp = await subtle.importKey("raw", kUp, "AES-GCM", false, ["encrypt"]);
const aesDown = await subtle.importKey("raw", kDown, "AES-GCM", false, ["decrypt"]);
for (const f of v.frames) {
  const params = { name: "AES-GCM", iv: nonce(f.frame.n), additionalData: enc.encode(`${v.label}/${f.dir}`) };
  if (f.dir === "up") {
    const c = await subtle.encrypt(params, aesUp, enc.encode(f.plaintext));
    check(`seal up n=${f.frame.n}`, b64.encode(c), f.frame.c);
  } else {
    const p = await subtle.decrypt(params, aesDown, b64.decode(f.frame.c));
    check(`open down n=${f.frame.n}`, new TextDecoder().decode(p), f.plaintext);
  }
}
console.log("all vectors reproduced with WebCrypto");
