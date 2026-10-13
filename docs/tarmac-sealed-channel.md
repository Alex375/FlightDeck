# Tarmac sealed channel — end-to-end phone ↔ node security (design draft)

Status: **draft, not yet validated.** It closes audit findings H1–H3 (2026-10-09). Once
validated, §3–§9 move into `flightdeck-remote/PROTOCOL.md`, which stays the authoritative
contract. Decisions marked **[D1]…[D4]** use the recommended option and still need sign-off
(see §12).

## 1. Problem

Today (verified on `tosse-code` dev, `flightdeckd` 0.4.0, Tarmac `main` +
`feat/multi-node-v2`):

- **H1. The relay sees and can forge everything.** Phone ↔ node frames travel in clear inside
  the relay process (TLS ends at Railway's edge). The relay, and whoever controls its hosting
  or its deploy, reads every prompt and reply. It can also inject `send_message` /
  `answer_request` frames, which a Mac or daemon would act on. Nodes never check where a frame
  came from: `appmcp/relay.rs::on_phone_frame` and `flightdeckd/src/relay.rs::read_loop` act
  on any `rpc`.
- **H2. One shared phone token.** A single UUID `phoneToken` (SQLite `meta.remote_phone_token`)
  is authorized identically on the Mac and on every paired server (`provision.rs` →
  `flightdeckd add-phone`). It never expires, and one phone cannot be removed without
  regenerating the pairing for all of them. The relay strips the token before forwarding, so
  a node cannot even tell which phone sent an `rpc`.
- **H3. Unpair does not stick.** A phone's `POST /phone/revoke` only drops the token at the
  relay. The Mac (`post_connect_frames`) and each daemon (`burst_keys`) re-send
  `authorize_phone` for it on every reconnect.

## 2. Goals and threat model

The adversary is the relay: its process, its host (Railway), its `state.json`, its logs, and
anyone who can push to Tarmac's `main`.

| Property | After this design |
|---|---|
| Confidentiality of app frames (prompts, replies, paths, push content) | ✅ The relay sees ciphertext only |
| Integrity: the relay cannot alter, forge, replay or reorder an `rpc` | ✅ AEAD + per-session counters |
| A node acts only on frames from a device it provisioned and that is not revoked or expired | ✅ |
| Forward secrecy: a key leaked later does not open recorded traffic | ✅ Ephemeral ECDH per session |
| A compromised server cannot impersonate the phone to another node | ✅ Per-node keys |
| Revoke ONE phone; expiry; Unpair sticks | ✅ §7 |
| Metadata (who talks to which node, when, sizes, online state) | ❌ Still visible to the relay |
| Availability (the relay can drop frames, lie about `mac_offline`) | ❌ Out of scope |
| **A malicious deploy of the PWA's own JavaScript** | ❌ Residual risk **[D3]**, §10 |

## 3. Identities and secrets

All are minted **by the Mac** (the admin console, per `flightdeckd/docs/CADRAGE.md`). A
server's `flightdeckd` no longer mints phone credentials.

| Name | What it is | Held by |
|---|---|---|
| `macId` | A node's id, unchanged. A daemon has its own. | relay, everyone |
| `device_id` (`d`) | 16 random bytes, base64url. One per paired phone. | Mac, nodes, phone |
| `rt` (relay token) | 32 random bytes, base64url. The phone's **routing** credential: `/phone` auth, `authorize_phone`, `POST /nodes`, `/push/*`. Stable for the device's life. It replaces the shared `phoneToken` and is no longer a security barrier: the relay sees it by definition. | relay (hashed), Mac, nodes, phone |
| `S` (device secret), generation `g` | 32 random bytes. The phone's master key. Never sent to the relay. | Mac, phone |
| `K_node` | `HKDF-SHA256(ikm=S, salt="tarmac-e2e/v1", info="node:" ‖ macId, L=32)`, one per (device, generation, node). | that node, phone (derives it) |

- The phone derives `K_node` for every node it discovers (`POST /nodes` or the QR's `macId`).
  The Mac provisions each daemon with **only its own** `K_node`.
- A relay that invents a `macId` cannot complete a handshake, because it does not know `S`.

### 3.1 Pairing link v2

```
https://<relay>/#v=2&macId=<issuer macId>&d=<device_id>&rt=<relay token>&k=<S>&g=<g>&relay=<origin, optional>
```

- It is still a fragment, so it is never sent to a server (the §10 caveat applies).
- The relay token is renamed `pt` → `rt` on purpose. An outdated PWA (old `parsePairingLink`
  requires `pt`) **refuses** a v2 link instead of pairing in clear.
- `macId` names the **issuer**: the Mac, the only node that can renew keys (§7.3).

## 4. Handshake

There is one handshake per phone socket, after the relay's `welcome` with `macOnline:true`.
Each side keeps a session per socket.

```
phone → node   {type:"e2e_hello", v:1, d, g, e:<P-256 public, raw 65 B, b64url>, n:<16 B b64url>}
node  → phone  {type:"e2e_accept", v:1, e, n, p:<32 B b64url>}           (targeted with _cid)
            or {type:"e2e_reject", v:1, reason}                            (targeted with _cid)
phone → node   sealed {type:"subscribe"}            ← proves the phone holds K_node
node  → phone  sealed {type:"ready", label, device:{g, expires_at, renew_after}, caps:[…]}
```

The keys are derived as follows. In `TH` each field is `lp(x) = u16be(len x) ‖ x`. `macId` is
its UTF-8 bytes; `d`, `e`, `n` are the raw decoded bytes (`e` = 65-byte uncompressed P-256,
WebCrypto's `exportKey("raw")`); `g` is `u32be`.

```
TH   = SHA-256( lp("tarmac-e2e/v1") ‖ lp(macId) ‖ lp(d) ‖ lp(g)
                ‖ lp(e_phone) ‖ lp(n_phone) ‖ lp(e_node) ‖ lp(n_node) )
OKM  = HKDF-SHA256(salt = K_node, ikm = ECDH(e_phone, e_node), info = "keys" ‖ TH, L = 96)
     → k_up (32) ‖ k_down (32) ‖ k_conf (32)
p    = HMAC-SHA256(k_conf, "node-accept" ‖ TH)
```

Reference implementation: `flightdeckd/tarmac-e2e`. Its `vectors/handshake-v1.json` pins
every value, and `vectors/check-webcrypto.mjs` reproduces them with WebCrypto, as the PWA
will (both run in CI).

This mixes a pre-shared key with an ephemeral DH, in the spirit of TLS 1.3 `psk_dhe_ke`.
Without `K_node` the relay can run the ECDH but cannot derive any key. The phone checks `p` in constant time before sending
anything.

**Reject reasons:** `unknown_device`, `unknown_generation`, `expired`, `busy`. A reject is
unauthenticated, because a relay can forge one. **The phone never deletes keys because of a
reject.** It shows the reason and retries the other generation it holds, if any.

**Limits on the node:**
- one `e2e_hello` per `_cid` per 2 s, and 10/s in total (each costs an ECDH);
- at most 16 live sessions, oldest evicted;
- a new hello on a known `_cid` replaces that session.

## 5. Sealed frames

```
{type:"e2e", n:<integer ≥ 0>, c:<b64url ciphertext‖tag>}      (+ _cid set by the relay / the node)
```

- **AEAD:** AES-256-GCM with `k_up` (phone → node) or `k_down` (node → phone).
- **Nonce:** `0x00000000 ‖ u64be(n)`.
- **AAD:** the ASCII string `"tarmac-e2e/v1/up"` or `"tarmac-e2e/v1/down"`.
- `n` starts at 0 and strictly increases per direction. The receiver drops `n ≤ last_n`. Gaps
  are allowed: the relay may drop frames, and each frame stands alone.
- **The plaintext is an existing app frame, byte-for-byte unchanged.**
  - Phone → node: `rpc`, `subscribe`, `ping`.
  - Node → phone: `rpc_result`, `rpc_error`, `event`, `pong`, `ready`.
  - §5 of PROTOCOL.md (methods, result shapes) does not change.
- **Events are sealed per session**: one frame per connected phone, targeted with its `_cid`.
  No sealed frame is ever broadcast.
- **A frame that fails to decrypt** is dropped and counted, never acted on. After 3 failures in
  one session, the node closes that session (logged) and the phone re-handshakes. The phone
  surfaces the count in Settings → Nodes. A failure is never silent.
- **Size:** base64 grows the payload by 4/3. The daemon trims `read_conversation` to 200 000 B,
  so a sealed frame can exceed the relay's 256 KB `maxPayload`. The relay raises it to
  **512 KiB**, and nodes cap any sealed plaintext at 384 KiB.

**Session end.** The node never learns that a phone left. The relay adds a new mac-side frame
`{type:"phone_left", _cid}` when a phone socket closes, and the node drops that session.
Older nodes ignore unknown types: the Mac has `_ => {}`, the daemon has a no-op.

## 6. Legacy and downgrade

A node cannot tell a cleartext frame from a legacy phone apart from one the relay forged. So
**while any legacy (shared-token) phone is authorized on a node, that node is still open to
injection.** Each node has a mode:

| `e2e_mode` | Cleartext app frames | Sealed |
|---|---|---|
| `allow` (transition) | accepted, as today | accepted |
| `require` | refused: `rpc_error "this machine only accepts encrypted connections — re-pair your phone"` | accepted |

- **Fresh installs start in `require`.** No legacy token is ever minted, and
  `flightdeckd init --no-phone-token` becomes the default.
- **Existing installs start in `allow`.** Settings shows a **"Legacy pairing (unencrypted)"**
  row with a warning and a **Retire** button. Retire revokes the shared token on the relay and
  on every server (the existing queues and tombstones), then switches every node to `require`.
- **A v2 pairing group on the phone never falls back to cleartext.** No `e2e_accept` within
  10 s means the node shows as "unreachable (encryption)", with the reason.

## 7. Device lifecycle

### 7.1 Records

```
Mac (SQLite v20)   remote_devices(device_id PK, label, relay_token, added_at, last_seen_at, revoked_at?)
                   remote_device_keys(device_id, g, secret, issued_at, expires_at, PK(device_id, g))
                   remote_device_push(device_id, endpoint_hash, subscription_json, prefs_json)
daemon config.json devices:[{device_id, label, relay_token, keys:[{g, key, issued_at, expires_at}],
                             last_seen_at, push:[…]}]      ≤ 2 generations kept per device
```

Secrets stay in SQLite, like the macToken today. `orchestrator.rs` explains why the Keychain
was not used.

### 7.2 Pair

1. Settings → **Pair a phone** asks for a label (default "iPhone").
2. The Mac mints `d`, `rt`, and `S` with `g=1`, issued now and expiring after 90 days **[D2]**.
3. On its own relay socket, the Mac sends `authorize_phone{phoneToken: rt}`.
4. On each server (SSH, stdin, like `add-phone` today), it runs `flightdeckd add-device`. The
   JSON passed is `{device_id, label, relay_token, g, key: K_node(server), issued_at, expires_at}`.
   The daemon persists it and authorizes `rt` on its own relay socket.
5. The Mac shows the v2 QR.

### 7.3 Renew **[D2: automatic rotation]**

1. When the phone has a session with the **issuer** and `now ≥ renew_after` (about
   `issued_at + 30 d`), it calls the sealed rpc `renew_device {}`.
2. The Mac mints `S` at `g+1` (90 days) and provisions each server with the matching `K_node`.
   Daemons keep 2 generations. A server that cannot be reached is queued; it still has `g`.
3. The Mac returns `{g, secret, expires_at, renew_after}`.
4. The phone keeps both generations and says hello with the newest. On `unknown_generation` it
   retries with the older one.
5. `g` expires on its own date. A phone that has not reached the Mac for 90 days must be
   re-paired.

### 7.4 Revoke (from the Mac)

1. In the Settings device row, **Revoke** marks the device revoked, sends
   `revoke_phone{rt}` on the Mac's relay socket, runs `flightdeckd remove-device` on each
   server, and kills live sessions on every node.
2. The existing undelivered-revocation machinery (v14 queues, v17 tombstones, init-token
   cleanup) is reused, keyed on `rt`.
3. Nodes refuse that device's hellos from then on.

### 7.5 Unpair (from the phone) — fixes H3

1. For every node, the phone sends the sealed rpc `forget_device {}`, then
   `POST /phone/revoke`.
2. A node that receives `forget_device` deletes the device and stops re-authorizing `rt`. The
   issuer Mac also runs `remove-device` on its servers.
3. Unconfirmed forgets wait in the F2 queue **together with the keys needed to authenticate
   them**, retried and given up after 7 days, as today.
4. A Mac or daemon re-authorizes **only devices still in its records**, never "the current
   token".

### 7.6 Expiry

- Every node refuses a hello whose generation is past `expires_at` (`expired`).
- The Mac lists devices with their last activity on each node (the daemon adds
  `devices:[{device_id, last_seen_at}]` to `fd_status`) and the expiry date.
- Expired devices are purged after 30 days.

## 8. Web Push **[D1: sealed by the node]**

The relay can no longer read events, so **the node builds and encrypts the push itself**.

- **Registration.** The phone sends each node its subscription and prefs over the sealed
  channel:
  - `push_register {subscription:{endpoint, keys:{p256dh, auth}}, prefs:{question, error, review}}`
  - `push_prefs {prefs}`
  - `push_unregister {}`

  It still `POST`s `/push/subscribe` to the relay, so the relay keeps its allow-list of push
  services and knows which endpoints belong to which `(macId, rt)`. **A v2 device sends the
  relay the `endpoint` only, never `keys.p256dh` / `keys.auth`.** Those go to the nodes alone,
  so the relay cannot encrypt a payload the browser would accept: it can no longer forge a
  notification. It can still drop or delay pushes (availability only).
- **Send.** The node classifies the event, applies the device's prefs, builds the payload, and
  encrypts it per **RFC 8291** (`aes128gcm`) for that subscription.
  - The classification is the same as `pushStateFor` today: `needs_attention` → question;
    `turn_completed` → error > question > review.
  - The payload keeps today's shape: `{title, body, kind, state, tag, data}`.
  - The node then sends `{type:"push_send", endpoint:<sha256 hex>, body:<b64url>, ttl, urgency}`.
- **Relay.** It consumes `push_send` (never forwards it) and accepts it only for an endpoint
  registered under that `macId`. It adds the VAPID headers and POSTs the body as is. A
  404/410/403 prunes the subscription, as today. `push_send` is rate-limited per mac.
- **The service worker does not change.** The browser decrypts.
- **Legacy-mode events** (cleartext, `e2e_mode=allow`) keep using the relay's `pushStateFor`
  path until legacy is retired.

## 9. Implementation map

| Where | What |
|---|---|
| **Crate** `flightdeckd/tarmac-e2e` (path dependency of `src-tauri` and `flightdeckd`) | **Done:** keys, handshake, sealed frames, RFC 8291 encryptor, interop vectors + WebCrypto check (in CI). **To do:** session table, push classification and payload. It sits under `flightdeckd/` because the daemon's musl build mounts only that directory; it moves when the repo becomes a Cargo workspace (`MONOREPO-MOVE.md`). Dependencies: `ring` 0.17 (already in both builds; fine on musl per B0), `base64`, `serde_json`. |
| **Tarmac relay** | `PHONE_ALLOWED` += `e2e_hello`, `e2e`; `phone_left` to the mac; `push_send`; `MAX_PAYLOAD` → 512 KiB; PROTOCOL.md §9 rewritten. It still reads **no** app content. |
| **Tarmac PWA** | `web/e2e.js` (vanilla JS + WebCrypto, CSP-compatible: no wasm, no eval). It plugs into the two choke points: the single `ws.send` in `rpc()` and `ws.onmessage` → `handleFrame`. Also: v2 `parsePairingLink`; `nodes.js` `toRecord` keeps `{v, deviceId, gens, issuer}`; the label from the sealed `ready` wins over `/nodes`; an "Encrypted" badge per node; Unpair sends `forget_device`. |
| **Mac** `appmcp/relay.rs` | Session table; `e2e_hello` / `e2e` / `phone_left` in `on_phone_frame`; events sealed per session in the events task; the cleartext path gated by `e2e_mode`; `Caller::Device(device_id)` for `last_seen`. |
| **Mac** devices | SQLite v20; IPC `list_remote_devices`, `pair_remote_device(label)`, `revoke_remote_device(id)`, `retire_legacy_pairing`; sealed rpcs `renew_device`, `forget_device`, `push_*`; `ControlSection.tsx` device list (replaces the single QR + "Regenerate"). |
| **Mac** `provision.rs` | `add-device` / `remove-device` instead of `add-phone` / `remove-phone` for v2 devices. A daemon older than 0.5.0 is "update needed to reach it from an encrypted phone". |
| **flightdeckd 0.5.0** | Config `devices`, `e2e_mode`; socket verbs `add_device`, `remove_device`, `set_e2e_mode` (and the CLI); `relay.rs` sessions via the crate; `burst_keys` authorizes the devices' `rt`; rpc `forget_device`, `push_*`; `fd_status.devices`; cap `e2e-devices`. Version bump (the Mac proposes an update only for a strictly greater version). |

## 10. Residual risk: the relay serves the PWA **[D3]**

The JS that reads the QR fragment and holds `S` is delivered by the relay. A malicious deploy
can ship code that exfiltrates the keys, and no web-side trick fixes that robustly: the
browser re-fetches `sw.js` from the origin itself.

This design protects against:
- a passive compromise (logs, memory, `state.json`, Railway access);
- frame injection at runtime;
- a compromised server attacking the other nodes.

It does **not** protect against a trojaned PWA build. Moving the PWA to GitHub Pages would
mostly move that trust: the same repository and the same `main` feed both. PROTOCOL.md §9
says this plainly. A separate task studies isolating the PWA's hosting.

## 11. Rollout

1. PROTOCOL.md: this contract (on top of the reconciled multi-node branch **[D4]**).
2. `tarmac-e2e` crate and vectors.
3. **Relay and PWA first.** They speak both modes, and the PWA refuses v2 links until updated,
   so nothing breaks.
4. flightdeckd 0.5.0 and the Mac (bundled together; the Mac upgrades its daemons as today).
5. Users re-pair their phones (v2), then click **Retire** on the legacy pairing → `require`.
6. Later release: remove the legacy code paths.

## 12. Decisions pending sign-off

- **[D1] Push — decided 2026-10-13:** sealed by the node (RFC 8291); the relay keeps the
  endpoint only, so it can neither read nor forge a notification.
- **[D2] Expiry — decided 2026-10-13:** 90-day keys with automatic rotation every ~30 days via
  the Mac.
- **[D3] PWA hosting — decided 2026-10-13:** document the residual risk in PROTOCOL.md §9 and
  open a separate task.
- **[D4] Tarmac base — decided 2026-10-13:** merge `main` into `feat/multi-node-v2` (Armand's
  branch, stopped 2026-09-18), land it on `main` with Armand, then build on it.
