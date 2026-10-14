# Tarmac sealed channel — end-to-end phone ↔ node security (design draft)

Status: **implemented (Mac, flightdeckd 0.5.0, crate; Tarmac on local branches), not yet released.** It closes audit findings H1–H3 (2026-10-09). Once
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

There is one handshake per phone socket, after **every** relay `welcome` with
`macOnline:true`: a node keeps its sessions per relay link, so a node restart or relink
drops them all. Each side keeps a session per socket.

```
phone → node   {type:"e2e_hello", v:1, d, g, e:<P-256 public, raw 65 B, b64url>, n:<16 B b64url>}
node  → phone  {type:"e2e_accept", v:1, e, n, p:<32 B b64url>}           (targeted with _cid)
            or {type:"e2e_reject", v:1, reason}                            (targeted with _cid)
phone → node   sealed {type:"subscribe"}            ← proves the phone holds K_node
node  → phone  sealed {type:"ready", label, device:{label, generation, expires_at_ms, renew_after_ms}, caps:[…],
                        nodes?:[macId…]}                         (nodes: the issuer Mac only, cap "node-list")
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

**Reject reasons:** `unknown_device`, `unknown_generation`, `expired`, `busy`, and `no_session`
(a sealed frame on a socket the node holds no session for — never opened, or dropped after 3
failures: the phone handshakes again). A reject is unauthenticated, because a relay can forge one. **The phone never deletes keys because of a
reject.** It shows the reason and retries the other generation it holds, if any.

**Limits on the node:**
- one `e2e_hello` per `_cid` per 2 s, and 10/s in total (each costs an ECDH);
- at most 16 live sessions. An accepted hello proves nothing (anyone who saw one can replay
  it), so a session counts only once it is **proven** — its first sealed frame opened under
  `k_up`. An unproven session lives 10 s at most, and a full table evicts the oldest
  **unproven** session first, a proven one only when every session is proven;
- a new hello on a known `_cid` replaces that session — **for the same device only**: a hello
  for another device on a socket whose session is proven is refused `busy` (a phone socket
  never changes device; the relay picks every `_cid`);
- "last seen" / `connected` are recorded when a session is **proven**, never at the hello.

**Replies are bound to their session.** A node seals a reply (`ready`, `pong`, `rpc_result`,
`rpc_error`) for the session the request came in on, identified by a per-session serial —
never for whatever session holds the `_cid` when the reply is ready. If that socket's session
changed meanwhile (replaced, dropped, expired), the reply is dropped. Without this, a relay
holding another device's key could swap its own session onto a phone's socket mid-request and
read the answer (a renewed secret above all).

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
- **A session dies with its key.** A node checks the session's generation against its
  `expires_at` on every sealed frame (answering `e2e_reject{expired}` and dropping the session)
  and on every broadcast, not only at the hello. When a device's key book changes (a generation
  pruned, or its key bytes replaced), every session on a generation no longer there ends.
- **A frame that fails to decrypt** is dropped and counted, never acted on. After 3 failures in
  one session, the node closes that session (logged) and the phone re-handshakes. The phone
  surfaces the count in Settings → Nodes. A failure is never silent.
- **Size:** base64 grows the payload by 4/3. The daemon trims `read_conversation` to 200 000 B,
  so a sealed frame can exceed the relay's 256 KB `maxPayload`. The relay raises it to
  **520 KiB**, and nodes cap any sealed plaintext at **380 KiB** (≈ 519 000 bytes sealed).

**Session end.** A node that drops a session after 3 failures answers the next sealed
frame on that socket with `e2e_reject{reason:"no_session"}`. The node never learns that a phone left. The relay adds a new mac-side frame
`{type:"phone_left", _cid}` when a phone socket closes, and the node drops that session.
Older nodes ignore unknown types: the Mac has `_ => {}`, the daemon has a no-op.

## 6. Legacy and downgrade

A node cannot tell a cleartext frame from a legacy phone apart from one the relay forged. So
**while any legacy (shared-token) phone is authorized on a node, that node is still open to
injection.** The rule, with no extra setting:

- **A node takes cleartext app frames only while at least one legacy phone token is
  authorized on it.** With none, a cleartext `rpc` gets
  `rpc_error "this machine only accepts encrypted connections — re-pair your phone"`, and
  events are never sent in clear.
- **Fresh installs never mint a legacy token**, so they are sealed-only from the start. Nor does
  an install whose remote access was **never turned on**: older builds minted the shared token
  at every launch regardless, so its presence proves nothing — it is retired (queued for
  revocation everywhere) before access is ever enabled.
- **The legacy pairing can no longer be regenerated.** No legacy QR is shown anywhere, so a
  regenerated shared token would reach no phone and only keep the cleartext path open;
  `set_remote{regenerate_pairing}` is refused and every former "Regenerate" button retires it.
- **An older server is open regardless of tokens.** A `flightdeckd` older than 0.5.0 runs every
  cleartext `rpc` its relay link brings, whatever phone is authorized. The Mac reads every
  RUNNING daemon's `fd_status` (`version`, `legacy_phones`) on each sync and names, in
  Settings → Phones, every server that still takes unencrypted commands, until it no longer
  does. The Retire dialog promises nothing for such a server.
- **Retire never races a re-authorization.** Every legacy `add-phone` / `remove-phone` round
  trip is serialized, and an `add-phone` re-checks — under that lock — that the token is still
  current and the server still paired; a retire's removal on that server then runs after it.
- **Existing installs** keep their legacy token. Settings shows a **"Legacy pairing
  (unencrypted)"** row with a warning and a **Retire** button. Retire revokes the shared
  token on the relay and on every server (the existing queues and tombstones), which closes
  the cleartext path everywhere.
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
2. The Mac mints `d`, `rt`, and `S` with `g=1` — a **bootstrap** generation: it expires after
   **24 h** and is due for renewal **at once** (`renew_after = issued_at`). The secret the QR
   carries (seen on screen, photographed, left in a clipboard or a chat) is worthless once the
   phone has connected, and a code never scanned dies on its own. At most 32 devices are paired
   (the same cap as every daemon). "Copy link" clears the clipboard a minute later if it still
   holds the link.
3. On its own relay socket, the Mac sends `authorize_phone{phoneToken: rt}`.
4. On each server (SSH, stdin, like `add-phone` today), it runs `flightdeckd add-device`. The
   JSON passed on stdin is
   `{device_id, label, relay_token, keys:[{generation, key: K_node(server), issued_at_ms, expires_at_ms}]}`
   (every generation the Mac holds, at most 2), answered `{type:"fd_device_added", ok, added}`.
   The daemon persists it and authorizes `rt` on its own relay socket. `K_node` is derived for the
   relay identity the server reports (`flightdeckd whoami`, pinned once recorded); an identity
   that is this Mac's own or another paired server's is refused — that server would otherwise
   get the key a phone uses with another node.
5. The Mac shows the v2 QR.

### 7.3 Renew **[D2: automatic rotation]**

1. When the phone has a session with the **issuer** and `now ≥ renew_after` (`issued_at` for
   the bootstrap generation, `issued_at + 30 d` after), it calls the sealed rpc `renew_device {}`.
2. The issuer answers by the generation **the asking session handshook with** (`s`), never by
   the device alone — otherwise an old secret (a photographed QR, an old backup) would buy fresh
   keys forever and lock the real phone out:
   - `s` is the newest and due → **mint** `S` at `s+1` (90 days) and provision each server with
     the matching `K_node`. Two renewals racing get the SAME new generation: the store only adds
     `s+1` over `s`.
   - `s` is the newest, not due → `{renewed:false, generation, expires_at_ms, renew_after_ms}`.
   - `s` is the generation an **unused** newest replaces → that newest **again** (its first answer
     may have been lost — renewal is idempotent for its holder).
   - anything else (unknown, expired) → `rpc_error`, logged.
3. A renewal answers `{renewed:true, generation, secret, issued_at_ms, expires_at_ms, renew_after_ms}`.
4. **The older generation is pruned as soon as the newest is used**: the first session proven on
   the newest generation removes the older ones from the Mac's records, ends every session still
   on them, and re-provisions every server with the pruned key set (`add-device` key sets are
   authoritative: a generation the Mac no longer sends is dropped by the daemon, and its sessions
   end there too). Until then the phone keeps both and says hello with the newest; on
   `unknown_generation` it retries with the older one.
5. `g` expires on its own date. A phone that has not reached the Mac for 90 days must be
   re-paired.

### 7.4 Revoke (from the Mac)

1. In the Settings device row, **Revoke** forgets the device, queues `revoke_phone{rt}` and a
   `flightdeckd remove-device` owed by EVERY paired server — one transaction — then sends the
   revocation on the Mac's relay socket (and on every later connect until the relay acknowledges it:
   revocations lead each connect burst, paced at ≤ 20 frames/s like the daemon's, and leave the
   queue only on the pong of a ping sent behind them), kills its live
   sessions, and runs the removals. A provisioning in flight when it lands is undone by the
   same sync. Removals not confirmed are retried every 10 minutes and at launch; a server
   removed meanwhile keeps a tombstone until it confirms.
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

- Every node refuses a hello whose generation is past `expires_at` (`expired`), and drops a
  live session once its generation expires (§5).
- A device with no generation left valid gets no Web Push (they carry agent text) and its relay
  token is no longer re-authorized on connect.
- The Mac lists devices with their last activity on each node (the daemon adds
  `devices:[{device_id, last_seen_at}]` to `fd_status`) and the expiry date.
- Expired devices are purged 30 days after their last key expired: revoked like a Settings
  revoke (relay token revoked, removal owed by every server). Checked at launch and every 10
  minutes.

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
  - The payload keeps today's shape: `{title, body, kind, state, tag, data}`, plus, in `data`:
    `g` (the device's newest valid generation on this node), `at` (when the node wrote it, ms),
    `id` (16 random bytes, base64url) and `sig` = `base64url(HMAC-SHA256(K_push, signed_bytes))`,
    where `K_push = HKDF-SHA256(ikm = K_node(g), salt = "tarmac-e2e/v1", info = "push", 32)` and
    `signed_bytes` = `"push"`, `data.macId`, `u32be(g)`, `u64be(at)`, `data.id`, `tag`, `title`,
    `body`, `kind`, `state`, `data.conversationId`, `data.url`, `data.sessionId` — each string as
    `u32be(len) ‖ UTF-8`, an absent one as `""` (vector: `handshake-v1.json` → `push`).
    **Every node holds the browser's subscription keys** (a browser has one subscription), so
    RFC 8291 alone cannot tell which node wrote a notification: the signature can — only that
    node and the phone hold `K_node`. A server cannot pose as the Mac, nor the relay as anyone.
  - The node then sends `{type:"push_send", endpoint:<sha256 hex>, body:<b64url>, ttl, urgency}`.
- **Relay.** It consumes `push_send` (never forwards it) and accepts it only for an endpoint
  registered under that `macId`. It adds the VAPID headers and POSTs the body as is. A
  404/410/403 prunes the subscription, as today. `push_send` is rate-limited per mac.
- **The service worker verifies before it shows.** The browser decrypts; the service worker
  derives `K_node(data.macId)` for generation `data.g` from the device secret it holds,
  recomputes `sig`, and drops (or shows generically) a push that does not verify, one older than
  `ttl` (600 s), an `id` it has already shown, a `data.macId` the issuer's `ready.nodes` no longer
  lists (a server removed from the Mac), and any non-relative `data.url`.
- **Legacy events** (cleartext, sent only while a legacy phone is authorized) keep using the relay's `pushStateFor`
  path until legacy is retired.

## 9. Implementation map

| Where | State |
|---|---|
| **Crate** `flightdeckd/tarmac-e2e` (path dependency of `src-tauri` and `flightdeckd`) | **Done.** Keys and lifetimes, handshake, sealed frames, node session table (`NodeChannel`), push classification + payload, RFC 8291 encryptor. Pinned by RFC 5869 / RFC 8291 known answers and `vectors/handshake-v1.json`, which `vectors/check-webcrypto.mjs` reproduces with WebCrypto (both in CI). Under `flightdeckd/` because the daemon's musl build mounts only that directory. |
| **flightdeckd 0.5.0** | **Done** (contract in `flightdeckd/docs/M1-DAEMON.md` § Sealed channel). |
| **Mac** `appmcp/relay.rs`, `appmcp/devices.rs` | **Done.** Live device book + sealed sessions in the hub; sealed rpcs `renew_device` (issuer only), `forget_device`, `push_*`; cleartext open only while the legacy token is in use. |
| **Mac** devices, `appmcp/device_provision.rs`, `ipc/remote_devices.rs` | **Done.** SQLite v20; pairing link v2; provisioning by `add-device` / `remove-device`, retried at launch, after every change and every 10 minutes while something is owed (judged against `fd_status.devices`); IPC `list_remote_devices`, `pair_remote_device`, `revoke_remote_device`, `retire_legacy_pairing`, `retry_device_provisioning`. A fresh install never mints the legacy token. A removed server that does not confirm forgetting a phone keeps a tombstone, retried until it does. |
| **Mac** Settings | **Done.** Remote access → Phones (`PhonesPanel.tsx`, `phonesModel.ts`). |
| **Tarmac** relay + PWA | **Done on local branches** `feat/multi-node-reconcile` (main ⊕ multi-node-v2) and `feat/sealed-channel` (PROTOCOL.md §11, relay frames, `web/e2e.js` reproducing the vectors, v2 pairing, sealed push). Not pushed. |

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
3. **Relay and PWA first.** They speak both modes, and an outdated PWA refuses v2 links, so
   nothing breaks. ⚠️ A Mac release with this change must NOT ship before: a fresh install pairs
   on the sealed channel only, which an old relay drops (`PHONE_ALLOWED`).
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
