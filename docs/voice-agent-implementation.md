# In-app Voice Agent — implementation guide (portable)

A complete, copy-pasteable description of the **in-app voice agent** feature:
a hands-free "cockpit voice" that speaks fleet events aloud and lets the user
talk back to pilot the app, built on **OpenAI Realtime (speech-to-speech) over
WebRTC** from the webview.

This document is self-contained: it explains the architecture, the exact wire
protocol, every design particularity, the problems that were hit and how they
were solved, and it includes the full source of the portable core modules so
the feature can be recreated in another repo.

> Origin: branch `feat/voice-agent` of the Tauri 2 desktop app *Flight Deck*
> (Rust core + React/TypeScript webview). Where a piece is app-specific it is
> flagged **ADAPT** with what to replace.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Prerequisites & dependencies](#2-prerequisites--dependencies)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [The two-layer mental model](#4-the-two-layer-mental-model-the-single-most-important-idea)
5. [Security model: who holds the key](#5-security-model-who-holds-the-key)
6. [The OpenAI Realtime WebRTC wire protocol](#6-the-openai-realtime-webrtc-wire-protocol-exact-shapes)
7. [Tool calling (the agent pilots the app)](#7-tool-calling-the-agent-pilots-the-app)
8. [Fleet announcements pipeline](#8-fleet-announcements-pipeline)
9. [Push-to-talk (customizable key)](#9-push-to-talk-customizable-key)
10. [UI surfaces](#10-ui-surfaces)
11. [Lifecycle invariants — the 13 review findings](#11-lifecycle-invariants--the-hard-won-bug-fixes)
12. [Files & integration checklist](#12-files--integration-checklist)
13. [Full source of the portable core](#13-full-source-of-the-portable-core)

---

## 1. What it does

While the app runs a fleet of background agents/conversations, the voice agent
gives it a **voice cockpit**:

- **Arm** a persistent voice session (headset button, or a key). Arming opens a
  Realtime session with the **microphone closed** — a silent, output-only
  session that exchanges no audio and can stay up all day.
- When a **fleet event** happens (an agent finished a turn, or one is blocked on
  a permission prompt / waiting on a question), the agent **says it aloud** in
  one or two sentences and **opens the mic** so the user can answer immediately.
- The user can **push-to-talk** at any time (default: a clean tap of **Right ⌘**,
  or a mic button) to ask "what's the status", "reply to conversation X …",
  "open that file", etc. The agent grounds every answer in tools.
- Saying "c'est bon / that's all / raccroche" makes the agent close the mic
  (`end_call`) while keeping the session armed for the next event.
- A **silence guard** closes the mic after N seconds of quiet (cost + privacy),
  never the session.

It is **strictly optional**: with no OpenAI key stored, the whole feature is
invisible and inert — no buttons, no polling, no startup cost, no error.

---

## 2. Prerequisites & dependencies

**Runtime / platform**

- A **WebView that supports WebRTC + `getUserMedia`** (WKWebView on macOS via
  Tauri works; verify on your platform). The audio sink `<audio>` element must
  be attached to the DOM for WebKit to play remote audio.
- **macOS Keychain** via `/usr/bin/security` for at-rest key storage. On other
  OSes swap this for the platform secret store (Windows Credential Manager,
  libsecret, …) — the module boundary makes this a single-file change.
- An **OpenAI API key** with Realtime access. The model used is `gpt-realtime`
  (GA speech-to-speech), voice `marin`.

**Rust crates** (already used by the host app; versions are what mattered):

- `reqwest` built with `rustls-no-provider` + `rustls` (`ring`) — a process-wide
  `ring` crypto provider is installed before the first HTTPS client.
- `serde` / `serde_json`, `specta` (typed IPC contract Rust→TS), `tauri` +
  `tokio` (for `spawn_blocking`).

**Front (TypeScript)**

- `zustand` for the two tiny in-memory/localStorage stores.
- No SDK for OpenAI Realtime — the transport is hand-rolled `RTCPeerConnection` +
  a `fetch` for SDP exchange. **No extra npm dependency is required.**

**TCC / entitlements**

- macOS `Info.plist` must declare `NSMicrophoneUsageDescription`, e.g.
  `"<app> uses the microphone only while you talk to the voice agent (push-to-talk)."`
- The Tauri app CSP must allow the WebRTC connection and the two OpenAI hosts.
  In the host app the CSP is `null` (unrestricted); if you enforce a CSP, allow
  `connect-src https://api.openai.com` and the WebRTC/STUN traffic.

---

## 3. Architecture at a glance

Three layers, each with one job:

```
┌──────────────────────── Webview (React / TS) ────────────────────────┐
│                                                                       │
│  VoiceToggle (title bar)   VoiceAgentSection (Settings)               │
│         │                          │                                  │
│         ▼                          ▼                                  │
│  ┌──────────────── realtime.ts (session manager, OUTSIDE React) ───┐  │
│  │  RTCPeerConnection + "oai-events" data channel                  │  │
│  │  mic via replaceTrack · function-call loop · end_call           │  │
│  └───────────▲───────────────────────────────────▲────────────────┘  │
│              │ announcements                      │ tool exec         │
│   announce.ts (pure queue)          appControl.ts executor (shared)   │
│              ▲                                                         │
│   VoiceHost (drains queue 1-at-a-time, registers helpers, PTT)        │
│              ▲                                                         │
│   useGlobalSessionEvents.fireAgentNotification (the ONE producer)     │
│                                                                       │
│   voiceStore (in-mem runtime state) · voicePrefs (localStorage)       │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ IPC (tauri-specta typed commands)
┌──────────────────────────────▼───────────────────────────────────────┐
│                         Rust core                                      │
│  voice/mod.rs  = THE ONLY owner of the OpenAI key                      │
│    • Keychain read/write/clear (verified by read-back)                 │
│    • mint short-lived client secret (POST /v1/realtime/client_secrets) │
│  appmcp/tools.rs = shared tool catalogue (one source, N surfaces)      │
│  fs/mod.rs::folder_tree = bounded dir tree for `browse_folders`        │
└───────────────────────────────────────────────────────────────────────┘
```

**Design rule inherited from the app:** normalization/ownership in Rust, the UI
is "dumb". The webview never holds the long-lived key; it only ever receives a
one-shot ephemeral secret.

---

## 4. The two-layer mental model (the single most important idea)

Everything falls out of separating two independent booleans:

| Concept | Store field | What it means | Toggled by |
|---|---|---|---|
| **Mode** (« session vocale ») | `mode` | The Realtime session is **armed** — up, but mic CLOSED. Announces events, no audio in. | Headset button, `toggleVoiceMode()` |
| **Microphone** | `micOpen` | Capture is **live right now** (macOS orange dot on). | Mic button, push-to-talk key, `toggleMic()` |

- An **armed, mic-closed** session exchanges no audio → it's cheap and can stay
  up indefinitely, ready to speak the next fleet event.
- The mic opens/closes **within** an armed session **without renegotiation**:
  the audio m-line is negotiated up-front as a `sendrecv` transceiver at connect
  time with **no track**, and the mic track is swapped in/out with
  `RTCRtpSender.replaceTrack(track | null)`. Closing truly **stops** the capture
  (`track.stop()`), so the orange indicator goes off.
- `phase` (`off | connecting | armed | listening | speaking | error`) is a
  display refinement of the two booleans.

This model was **the** correction from real-world test feedback (commit
`1cbae08`): the first version conflated "session" and "mic", so any silence
guard or hang-up killed the whole session and you lost the announce channel.

---

## 5. Security model: who holds the key

- The **long-lived OpenAI key lives only in Rust**, at rest in the macOS
  Keychain. The webview **never** sees it.
- Rust mints a **short-lived client secret** per session
  (`POST https://api.openai.com/v1/realtime/client_secrets`) and hands *that* to
  the webview. It opens exactly one WebRTC session and expires on its own — the
  only credential shape WebRTC needs.
- **Write is verified by read-back**: after `security add-generic-password -U`,
  the code reads the item back and compares byte-for-byte. "Saved" must mean
  "stored intact", never a truncated item discovered next session.
- **Per-bundle-identity Keychain item name.** The service name is
  `"Flight Deck OpenAI"` in production, but **suffixed with the bundle
  identifier** for any non-production build:
  `"Flight Deck OpenAI (com.example.app.dev)"`. Without this, a dev/test build
  and the production app read, overwrite (`-U`) and delete the **same** item —
  a real cross-talk bug that had already burned the app's other credential
  stores. **ADAPT**: use your own service name + your own production identifier
  constant.
- **Keychain calls are async + `spawn_blocking`.** A Keychain ACL prompt can
  block for seconds; it must never run on the main thread.
- **Absence is a normal state**, never an error. No key → `configured:false` →
  the UI locks the feature with the reason spelled out; nothing else in the app
  touches the module. A denied/failed read reads as "not configured" (it
  resolves itself the next time macOS re-prompts).
- **Loose key validation**: reject only what can *never* be a key (empty, <20
  chars, whitespace). Let the first mint surface a wrong-but-plausible key as a
  clear `401`. OpenAI key prefixes evolve (`sk-`, `sk-proj-`, …) — don't hard-code.

---

## 6. The OpenAI Realtime WebRTC wire protocol (exact shapes)

This is the part hardest to rediscover. GA Realtime, WebRTC transport:

### 6.1 Mint an ephemeral secret (Rust, with the long-lived key)

```
POST https://api.openai.com/v1/realtime/client_secrets
Authorization: Bearer <LONG_LIVED_KEY>
Content-Type: application/json

{ "session": { "type": "realtime",
               "model": "gpt-realtime",
               "audio": { "output": { "voice": "marin" } } } }
```

Response (top-level): `{ "value": "<ephemeral>", "expires_at": <unix_secs>, ... }`.
Model + voice are fixed **at mint time**.

### 6.2 Open the WebRTC call (webview, with the ephemeral secret)

1. `pc = new RTCPeerConnection()`
2. Create a hidden `<audio autoplay>` sink, append it to `document.body`, set
   `sink.srcObject` from `pc.ontrack`.
3. `const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" })`
   — **no capture yet** (mic attaches later).
4. `const dc = pc.createDataChannel("oai-events")`.
5. `const offer = await pc.createOffer(); await pc.setLocalDescription(offer)`.
6. SDP exchange over HTTP:

```
POST https://api.openai.com/v1/realtime/calls?model=<model>
Authorization: Bearer <EPHEMERAL>
Content-Type: application/sdp

<offer.sdp>
```

7. `await pc.setRemoteDescription({ type: "answer", sdp: <response body> })`.

### 6.3 Configure the session (on data-channel open)

Send over the data channel once `dc.onopen` fires:

```json
{ "type": "session.update",
  "session": { "type": "realtime",
               "instructions": "<system prompt>",
               "tools": [ /* function tools */ ],
               "tool_choice": "auto" } }
```

### 6.4 Inbound events you handle (`dc.onmessage`, JSON)

| `type` | Meaning / action |
|---|---|
| `input_audio_buffer.speech_started` | user speaking → `phase = listening` |
| `output_audio_buffer.started` | agent audio playing → `phase = speaking` |
| `output_audio_buffer.stopped` | agent audio done → back to resting phase (or close mic if `end_call` pending) |
| `response.created` | `activeResponses += 1` |
| `response.done` | `activeResponses -= 1`; flush "wait for quiet" waiters |
| `response.output_item.done` with `item.type === "function_call"` | run the tool call (§7) |
| `error` | log only — the **connection-state** handler decides death, not this |

> **`output_audio_buffer.*` is load-bearing:** audio playback outlives the data
> channel's response events. Track speaking via these, or the silence guard cuts
> the agent off mid-sentence.

### 6.5 Function-call reply

```json
{ "type": "conversation.item.create",
  "item": { "type": "function_call_output", "call_id": "<id>", "output": "<JSON string>" } }
```
then `{ "type": "response.create" }` to let the agent speak the result.

### 6.6 Injecting a fleet event as a user message

```json
{ "type": "conversation.item.create",
  "item": { "type": "message", "role": "user",
            "content": [ { "type": "input_text", "text": "<event line>" } ] } }
```
then `{ "type": "response.create" }`.

### 6.7 Connection-state teardown rule

Only `pc.connectionState === "failed" | "closed"` tears the session down.
`"disconnected"` is a **transient** WebRTC state (brief ICE liveness loss that
usually self-recovers) — do **not** tear down on it.

---

## 7. Tool calling (the agent pilots the app)

The voice agent's function tools come from the **same catalogue** the app's MCP
servers serve, so there is one source and no drift.

- Rust exposes the catalogue as JSON via an IPC command
  (`app_control_tools(surface)` → `{ tools: [{name, description, inputSchema}] }`).
- On connect, the front fetches it, filters to the **voice subset**, maps each
  entry to a Realtime function tool `{ type:"function", name, description,
  parameters: inputSchema }`, and appends the session-local `end_call` tool.
- Each `function_call` is executed through the **shared app-control executor**
  (`executeAppControlTool(name, args, caller, helpers)`) — the exact same code
  path the in-process MCP server uses. The result (or `{error}`) goes back as
  `function_call_output` content, so the agent can read errors aloud and recover.

**Voice tool subset** (conversation piloting + showing things on screen):

```
list_conversations, read_conversation, send_message, create_conversation,
browse_folders, focus_conversation, rename_conversation,
open_file, open_view, open_panel
```

Deliberately **excluded**: `wait_for_events` (events are pushed as spoken
announcements, not polled), `whoami` (a voice caller has no own conversation),
`notify_user` (the voice *is* the notification). And the catalogue itself omits
anything destructive/privilege-raising (no permission-mode change, no remote
control, no delete/wipe, no rewind/fork, no terminal writes).

**`end_call`** is a session-local tool (not in the shared catalogue): it closes
the **mic** and keeps the session armed. The agent is instructed to say a short
goodbye *before* calling it; the mic is then closed when the goodbye finishes
playing (`output_audio_buffer.stopped`/`response.done`), with a hard 15 s
fallback so a silent goodbye can't leave the capture open.

**`browse_folders`** was added so the agent can locate a repo path itself
instead of making the user dictate one: a compact, depth- and size-bounded
directory tree (git repos marked and **not** descended into; hidden/noise dirs
skipped; 150-line cap with **loud** truncation). Built off-thread in Rust
(`fs::folder_tree`) because a cloud-synced folder can stall the walk.

**ADAPT**: replace the tool set + executor with your app's own action surface.
The pattern to keep: *one catalogue, executed through one shared executor,
filtered per surface.*

### 7.1 System prompt (instructions)

```
You are <App>'s voice agent — the cockpit voice for the fleet of agents
(conversations) the user runs in the <App> desktop app.
Style: spoken and brief — one to three short sentences, unless asked for detail.
Match the user's spoken language (this user usually speaks French).
Ground everything in the tools: list_conversations for live statuses,
read_conversation before summarizing a reply, send_message to relay the user's
answer (name the target conversation before sending when there could be doubt).
Never invent conversation ids or content.
When a [<App> event] message arrives, tell the user what happened in one or two
sentences, then ask if they want to react — their microphone was just opened.
When the user says they are done, say a short goodbye and call end_call. When
they ask to work in a folder you don't know, orient with browse_folders first.
```

---

## 8. Fleet announcements pipeline

The agent announces **exactly what would have pinged the human** — the same
settled notification point that feeds OS notifications (and, in the host app,
the voice-bridge journal). One truth about "what just happened", three
consumers.

```
fireAgentNotification(convId, kind)          ← the ONE producer, after the
   (settle window elapsed, no-op turns          settle window, minus no-ops,
    excluded, interrupted turns excluded)        minus interrupted turns
        │  if voiceStore.mode (ARMED)
        ▼
queueVoiceAnnouncement(a)   → FIFO queue, capped at MAX_QUEUE (5)  [announce.ts]
        │  (event listener)
        ▼
VoiceHost drain loop  ── draining latch: ONE spoken response at a time
        │  await sayAnnouncement(a)   (resolves when the response is done)
        ▼
realtime.sayAnnouncement(a):
   open the mic for the reply → wait for quiet (activeResponses==0, bounded)
   → inject the event as a user message → response.create → await done (bounded)
```

Key points:

- **Producer-side gating**: enqueue only while `mode` is armed, so a disabled
  feature costs nothing. The queue is **capped** (keep the freshest 5) — a long
  absence must not make the agent monologue for minutes.
- **Structured line, not spoken text**: `announcementText(a)` builds a complete
  `[App event] The conversation "<title>" (repo X) finished its turn. Its last
  reply: … Summarize to the user in one or two spoken sentences and ask if they
  want to reply. conversation_id: <id>`. The agent *rephrases* it per its style
  instructions.
- **Sequential drain**: the `draining` latch + `sayAnnouncement` resolving at
  response-end guarantees the agent never talks over itself. If the mode is
  disarmed or the session errors mid-drain, the **backlog is dropped** (stale)
  rather than retried or used to resurrect a session.
- **Never talk over an active response**: `sayAnnouncement` waits for
  `activeResponses === 0` (bounded 30 s) before `response.create`, because the
  server rejects a second active response.

**ADAPT**: `fireAgentNotification` is app-specific. Wire the enqueue into
*whatever* single point already decides "notify the human", so the spoken line,
the OS ping, and any other channel share one source.

---

## 9. Push-to-talk (customizable key)

The PTT key is **user data** (customizable), so it lives in `voicePrefs`
(localStorage) rather than the app's static shortcut registry, and is matched by
`VoiceHost`'s own `window` listener.

Two shapes, one type (`PttShortcut`):

- **Modifier tap** (the default, `{ code: "MetaRight", tap: true }`): pressing
  **and releasing** the modifier *alone* fires. A stateful detector arms on the
  modifier's keydown and **disarms the instant any other key goes down while
  it's held** — so using the same key inside a chord (⌘C with the right thumb)
  never triggers PTT. Fires on keyup only if still armed.
- **Regular key chord** (e.g. `⌘⇧V`, `F13`): matched on keydown with exact
  modifiers, consuming the event.

Uses `KeyboardEvent.code` (physical key): AZERTY-safe, and the only way to tell
**Right** from **Left** modifiers apart. Firing `toggleMic()` **arms the session
first** if cold. Inert when no key is configured (event left untouched).

A **shortcut recorder** in Settings turns the next clean gesture into a
`PttShortcut` (`shortcutFromEvent`): a lone modifier → tap; any other key →
chord with held modifiers; Escape cancels.

---

## 10. UI surfaces

- **Title-bar buttons** (`VoiceToggle.tsx`), both hidden entirely until a key is
  configured (read from the shared `configured` mirror — no stale cache):
  - **Headset** = arm/disarm the mode (`toggleVoiceMode`).
  - **Mic** = open/close the mic (`toggleMic`), rendered only while armed; title
    shows the PTT key label.
- **Settings → "MCP Control" tab → "Voice agent" card** (`VoiceAgentSection.tsx`):
  - **OpenAI API key** row: password input → `setVoiceAgentKey`; when configured,
    shows the masked hint (`sk-…d4f2`) + Remove. Honest read-back Rust-side.
  - **Push-to-talk key** row: label + a Change button that runs the recorder.
  - **Close the mic after silence** row: numeric seconds (clamped 10–300).
- **Shared runtime mirror** (`voiceStore.configured`): one synchronous boolean,
  seeded at boot by `VoiceHost` from `voice_agent_status`, updated live by the
  Settings card on save/remove. It drives chip visibility, PTT inertness, and
  the announcement gate so they can never disagree.

---

## 11. Lifecycle invariants — the hard-won bug fixes

These came from an **adversarial review** (commit `b847787`, "13 verified
findings") plus real test feedback (`1cbae08`). Each is a regression trap; do
not undo them.

1. **A failed start releases everything it acquired** (mic tracks, peer
   connection, audio sink). Hoist those locals so the `catch` can clean them —
   never a hot microphone behind an error chip.
2. **`session.ready` always settles** (`open → resolve`, `teardown → reject`).
   Nothing can park forever on a data channel that never opens; the announcement
   drain would wedge otherwise. A rejected `ready` is normal teardown — swallow
   it (`void ready.catch(() => {})`).
3. **A data channel that never opens becomes a failure**, not a forever-
   "connecting" chip: a 10 s watchdog tears the session down + surfaces the error.
4. **The idle cost-guard re-arms while `phase === "speaking"`** and only ever
   closes the **mic**, never the session. Audio outlives dc events (see §6.4).
5. **Only `failed`/`closed` connection states tear down.** `"disconnected"` is
   transient.
6. **PTT during an in-flight announcement-connect is honored, not swallowed**:
   `toggleMic`/`toggleVoiceMode` `await` the in-flight start first, then act.
7. **A real hang-up drops the announcement backlog** (`clearVoiceAnnouncements`)
   so the drain can't reopen a session just to finish reading stale events.
8. **Announcements never talk over an active response**: bounded quiet-wait on
   `activeResponses` before `response.create`.
9. **Response waiters self-remove on their own timeout** — a stale resolver must
   never advance a *later* announcement's wait early.
10. **One synchronous `configured` mirror** drives visibility + PTT inertness +
    the announcement gate. Saving a key shows the chip immediately; removing it
    stops the machinery — no "appears after an app refocus".
11. **Keychain item suffixed per bundle identity** (prod/dev/test isolated).
12. **Keychain commands are async + `spawn_blocking`** (ACL prompt off the main
    thread).
13. **`end_call` closes the mic when the goodbye finishes playing**, with a hard
    15 s fallback so a silent goodbye can't leave the capture open.

Also verified/known:

- `getUserMedia` inside the Tauri WKWebView required the `Info.plist`
  `NSMicrophoneUsageDescription` string; confirm the permission prompt appears
  on first mic open on your platform.
- After the permission prompt returns, re-check the session is still the current
  one (`if (session !== s)`) — it may have died while the prompt was up; stop the
  freshly-granted tracks in that case.

---

## 12. Files & integration checklist

**New Rust**
- `src-tauri/src/voice/mod.rs` — key owner + secret minting (full source below).
- `src-tauri/src/fs/mod.rs` — add `folder_tree()` + `FolderTree` (for
  `browse_folders`).

**New front**
- `src/voice/realtime.ts` — session manager (full source below).
- `src/voice/announce.ts` — pure queue + line builder.
- `src/voice/voiceStore.ts` — in-memory runtime state (zustand).
- `src/voice/voicePrefs.ts` — localStorage prefs (zustand).
- `src/voice/pttShortcut.ts` — PTT type + pure detectors.
- `src/voice/VoiceHost.tsx` — render-null host (helpers + drain + PTT listener).
- `src/voice/VoiceToggle.tsx` — title-bar buttons.
- `src/features/settings/VoiceAgentSection.tsx` — Settings card.

**Edits to existing files**
- `lib.rs`: `pub mod voice;`, register the 6 IPC commands
  (`voice_agent_status`, `set_voice_agent_key`, `clear_voice_agent_key`,
  `voice_agent_client_secret`, `app_control_tools`, `folder_tree`), and call
  `voice::set_bundle_identifier(app.config().identifier.clone())` in `setup`.
- `ipc/commands.rs`: the 6 commands (async + `spawn_blocking` for the Keychain
  ones; `app_control_tools` returns the catalogue JSON per surface).
- `appmcp/tools.rs`: add `browse_folders` to the shared catalogue + Voice subset.
- `agent/appControl.ts`: add the `browse_folders` executor case.
- `useGlobalSessionEvents.ts`: in `fireAgentNotification`, enqueue a
  `queueVoiceAnnouncement` when `voiceStore.mode` is armed.
- `App.tsx`: mount `<VoiceHost/>` (render-null) and `<VoiceModeToggle/>` +
  `<VoiceMicToggle/>` in the title bar.
- `Info.plist`: `NSMicrophoneUsageDescription`.
- Settings panel: mount `<VoiceAgentSection/>`; regenerate the typed IPC bindings
  (tauri-specta) and commit them.
- Icons: add `mic` + `headset` glyph paths to your icon kit.

**IPC surface added** (all `Result<T, String>`):
`voice_agent_status() -> VoiceAgentStatus`,
`set_voice_agent_key(key) -> VoiceAgentStatus`,
`clear_voice_agent_key() -> VoiceAgentStatus`,
`voice_agent_client_secret() -> ClientSecret`,
`app_control_tools(surface: "app"|"voice") -> Value`,
`folder_tree(path?, depth?) -> FolderTree`.

---

## 13. Full source of the portable core

The modules below are the product; paste them and adapt the **ADAPT** points
(service name, production identifier, app name in the prompt, the tool set +
executor, and the notification producer).

### 13.1 `src-tauri/src/voice/mod.rs`

```rust
//! Voice-agent credentials + session minting — the ONE module that touches the
//! user's OpenAI API key. The webview never holds the long-lived key: it lives
//! in the Keychain (write verified by read-back), and the front only ever
//! receives a SHORT-LIVED client secret minted server-side.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "Flight Deck OpenAI";       // ADAPT
const KEYCHAIN_ACCOUNT: &str = "api-key";
const PRODUCTION_IDENTIFIER: &str = "com.tosse.desktop";   // ADAPT

static BUNDLE_IDENTIFIER: Mutex<Option<String>> = Mutex::new(None);

pub fn set_bundle_identifier(identifier: String) {
    if let Ok(mut g) = BUNDLE_IDENTIFIER.lock() { *g = Some(identifier); }
}

fn keychain_service() -> String {
    service_name_for(BUNDLE_IDENTIFIER.lock().ok().and_then(|g| g.clone()).as_deref())
}

/// Production keeps the bare name; every other identity gets its own item.
fn service_name_for(identifier: Option<&str>) -> String {
    match identifier {
        Some(id) if id != PRODUCTION_IDENTIFIER => format!("{KEYCHAIN_SERVICE} ({id})"),
        _ => KEYCHAIN_SERVICE.to_string(),
    }
}

const REALTIME_MODEL: &str = "gpt-realtime";
const REALTIME_VOICE: &str = "marin";
const MINT_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceAgentStatus { pub configured: bool, pub key_hint: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClientSecret { pub value: String, pub expires_at: i64, pub model: String }

fn key_hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("sk-…{tail}")
}

/// Reject only what can NEVER be a key; let the first mint judge the rest (401).
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() { return Err("the key is empty".into()); }
    if key.len() < 20 { return Err("that is too short to be an OpenAI API key".into()); }
    if key.chars().any(char::is_whitespace) { return Err("the key contains whitespace — check the copy/paste".into()); }
    Ok(())
}

/// Store (`-U` = update in place), then VERIFY by reading it back.
pub fn set_key(key: &str) -> Result<VoiceAgentStatus, String> {
    let key = key.trim();
    validate_key(key)?;
    let out = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", &keychain_service(), "-a", KEYCHAIN_ACCOUNT,
               "-D", "Flight Deck voice-agent OpenAI key", "-w", key])
        .output().map_err(|e| format!("failed to run /usr/bin/security: {e}"))?;
    if !out.status.success() {
        return Err(format!("Keychain write failed (exit {}): {}",
            out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).trim()));
    }
    match read_key() {
        Some(stored) if stored == key => Ok(status()),
        Some(_) => Err("the key came back altered after saving — not trusting the stored copy".into()),
        None => Err("the key vanished right after being saved".into()),
    }
}

/// Absent item = success (the goal state).
pub fn clear_key() -> Result<VoiceAgentStatus, String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", &keychain_service(), "-a", KEYCHAIN_ACCOUNT])
        .output().map_err(|e| format!("failed to run /usr/bin/security: {e}"))?;
    if !out.status.success() && out.status.code() != Some(44) { // 44 = item not found
        return Err(format!("Keychain delete failed (exit {}): {}",
            out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(status())
}

/// None when absent/denied (both read as "not configured").
fn read_key() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &keychain_service(), "-a", KEYCHAIN_ACCOUNT, "-w"])
        .output().ok()?;
    if !out.status.success() { return None; }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!key.is_empty()).then_some(key)
}

pub fn status() -> VoiceAgentStatus {
    match read_key() {
        Some(key) => VoiceAgentStatus { configured: true, key_hint: Some(key_hint(&key)) },
        None => VoiceAgentStatus { configured: false, key_hint: None },
    }
}

/// The ONLY place the long-lived key is used. Errors never contain the key.
pub async fn mint_client_secret() -> Result<ClientSecret, String> {
    let Some(key) = read_key() else {
        return Err("no OpenAI key configured — add one in Settings → Control".into());
    };
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| format!("HTTP client build failed: {e}"))?;
    let body = serde_json::json!({ "session": {
        "type": "realtime", "model": REALTIME_MODEL,
        "audio": { "output": { "voice": REALTIME_VOICE } } } });
    let resp = client.post(MINT_URL).bearer_auth(&key).json(&body).send().await
        .map_err(|e| format!("could not reach OpenAI: {e}"))?;
    let status_code = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status_code == reqwest::StatusCode::UNAUTHORIZED {
        return Err("OpenAI rejected the key (401) — check it in Settings → Control".into());
    }
    if !status_code.is_success() {
        return Err(format!("OpenAI answered {status_code}: {}", snippet(&text)));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("unreadable OpenAI response: {e}"))?;
    let value = parsed.get("value").and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("no client secret in the OpenAI response: {}", snippet(&text)))?
        .to_string();
    let expires_at = parsed.get("expires_at").and_then(serde_json::Value::as_i64).unwrap_or(0);
    Ok(ClientSecret { value, expires_at, model: REALTIME_MODEL.to_string() })
}

fn snippet(body: &str) -> String { body.chars().take(300).collect() }

/// reqwest is `rustls-no-provider`; install the process-wide `ring` provider
/// before the first client. Idempotent.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}
```

**IPC wrappers** (`ipc/commands.rs`) — Keychain ones are async + `spawn_blocking`:

```rust
#[tauri::command] #[specta::specta]
pub async fn voice_agent_status() -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(crate::voice::status).await
        .map_err(|e| format!("keychain task failed: {e}"))
}
#[tauri::command] #[specta::specta]
pub async fn set_voice_agent_key(key: String) -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(move || crate::voice::set_key(&key)).await
        .map_err(|e| format!("keychain task failed: {e}"))?
}
#[tauri::command] #[specta::specta]
pub async fn clear_voice_agent_key() -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(crate::voice::clear_key).await
        .map_err(|e| format!("keychain task failed: {e}"))?
}
#[tauri::command] #[specta::specta]
pub async fn voice_agent_client_secret() -> Result<crate::voice::ClientSecret, String> {
    crate::voice::mint_client_secret().await
}
#[tauri::command] #[specta::specta]
pub fn app_control_tools(surface: String) -> Result<serde_json::Value, String> {
    let surface = match surface.as_str() {
        "app" => crate::appmcp::Surface::App,
        "voice" => crate::appmcp::Surface::Voice,
        other => return Err(format!("unknown surface '{other}' (app | voice)")),
    };
    Ok(crate::appmcp::tools::list_json(surface))
}
```

### 13.2 `src/voice/realtime.ts` (session manager — the heart)

> Owned **outside React**: a module-level `session` singleton, components only
> render `voiceStore`. Replace `executeAppControlTool` + `VOICE_TOOL_NAMES` +
> `INSTRUCTIONS` with your app's own. The lifecycle invariants (§11) are all here.

```ts
import { commands } from "../ipc/client";
import { executeAppControlTool, type AppControlHelpers } from "../agent/appControl";
import { useVoicePrefs } from "./voicePrefs";
import { useVoiceStore } from "./voiceStore";
import { announcementText, clearVoiceAnnouncements, type FleetAnnouncement } from "./announce";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const VOICE_TOOL_NAMES = new Set([
  "list_conversations", "read_conversation", "send_message", "create_conversation",
  "browse_folders", "focus_conversation", "rename_conversation",
  "open_file", "open_view", "open_panel",
]);

const END_CALL_TOOL = {
  type: "function", name: "end_call",
  description:
    "Close the microphone and end the current exchange. Call it when the user says they are " +
    "done («c'est bon», «merci, c'est tout», «raccroche», “that's all”). The voice session " +
    "stays armed — you will still announce future fleet events. Say a brief goodbye BEFORE calling it.",
  parameters: { type: "object", properties: {}, required: [] },
};

const INSTRUCTIONS = `You are Flight Deck's voice agent — …`; // ADAPT (see §7.1)

interface LiveSession {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  micSender: RTCRtpSender;          // pre-negotiated; mic swapped with replaceTrack
  mic: MediaStream | null;
  audioEl: HTMLAudioElement;
  ready: Promise<void>;
  settleReady: (err?: Error) => void;   // ALWAYS settles
  idleTimer: ReturnType<typeof setTimeout> | null;
  activeResponses: number;          // response.created − response.done
  responseWaiters: Array<() => void>;
  endPending: boolean;              // end_call: close mic when goodbye finishes
}

let session: LiveSession | null = null;
let starting: Promise<void> | null = null;
let helpersRef: AppControlHelpers | null = null;

export function registerVoiceHelpers(h: AppControlHelpers | null): void { helpersRef = h; }
export function voiceSessionLive(): boolean { return session !== null; }

// ---- Mode (the armed "voice session") --------------------------------------
export async function toggleVoiceMode(): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (session) { clearVoiceAnnouncements(); teardownSession(); return; }
  await armVoiceSession().catch(() => {});
}
export async function armVoiceSession(): Promise<void> {
  if (session) return;
  if (starting) return starting;
  starting = doStart().finally(() => { starting = null; });
  return starting;
}

// ---- Microphone (within an armed session) ----------------------------------
export async function toggleMic(): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (!session) { await armVoiceSession().catch(() => {}); if (!session) return; }
  if (useVoiceStore.getState().micOpen) closeMic();
  else await openMic();
}

export async function openMic(): Promise<boolean> {
  const s = session;
  if (!s) return false;
  if (useVoiceStore.getState().micOpen) return true;
  try { await s.ready; } catch { return false; }
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const message = e instanceof DOMException && e.name === "NotAllowedError"
      ? "microphone access was denied — allow it in System Settings → Privacy & Security → Microphone"
      : `microphone unavailable: ${e instanceof Error ? e.message : String(e)}`;
    useVoiceStore.getState().fail(message);
    teardownSession();
    return false;
  }
  if (session !== s) { mic.getTracks().forEach((t) => t.stop()); return false; } // died during prompt
  const track = mic.getAudioTracks()[0] ?? null;
  try {
    await s.micSender.replaceTrack(track);
  } catch (e) {
    mic.getTracks().forEach((t) => t.stop());
    useVoiceStore.getState().fail(`could not attach the microphone: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  s.mic = mic;
  const store = useVoiceStore.getState();
  store.setMicOpen(true);
  if (store.phase !== "speaking") store.setPhase("listening");
  armIdleTimer(s);
  return true;
}

export function closeMic(): void {
  const s = session;
  if (!s) return;
  void s.micSender.replaceTrack(null).catch(() => {});
  s.mic?.getTracks().forEach((t) => t.stop());
  s.mic = null;
  const store = useVoiceStore.getState();
  store.setMicOpen(false);
  if (store.phase === "listening") store.setPhase("armed");
}

// ---- Session plumbing ------------------------------------------------------
async function doStart(): Promise<void> {
  const store = useVoiceStore.getState();
  store.setPhase("connecting");
  let pc: RTCPeerConnection | null = null;      // hoisted so catch can release all
  let audioEl: HTMLAudioElement | null = null;
  try {
    const secretRes = await commands.voiceAgentClientSecret();
    if (secretRes.status !== "ok") throw new Error(secretRes.error);
    const secret = secretRes.data;
    const toolsRes = await commands.appControlTools("app");
    if (toolsRes.status !== "ok") throw new Error(toolsRes.error);
    const catalogue = (toolsRes.data as { tools?: Array<Record<string, unknown>> }).tools ?? [];
    const tools = [
      ...catalogue.filter((t) => VOICE_TOOL_NAMES.has(String(t.name)))
        .map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
      END_CALL_TOOL,
    ];

    pc = new RTCPeerConnection();
    audioEl = document.createElement("audio");
    audioEl.autoplay = true; audioEl.style.display = "none"; audioEl.dataset.voiceAgent = "1";
    document.body.appendChild(audioEl);
    const sink = audioEl;
    pc.ontrack = (e) => { sink.srcObject = e.streams[0] ?? new MediaStream([e.track]); };
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" }); // no capture yet

    const dc = pc.createDataChannel("oai-events");
    let readyResolve!: () => void, readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
    let readySettled = false;
    const next: LiveSession = {
      pc, dc, micSender: transceiver.sender, mic: null, audioEl, ready,
      settleReady: (err?: Error) => {
        if (readySettled) return; readySettled = true;
        if (err) readyReject(err); else readyResolve();
      },
      idleTimer: null, activeResponses: 0, responseWaiters: [], endPending: false,
    };
    void ready.catch(() => {}); // rejected ready = normal teardown, never unhandled

    dc.onopen = () => {
      dcSend(next, { type: "session.update",
        session: { type: "realtime", instructions: INSTRUCTIONS, tools, tool_choice: "auto" } });
      useVoiceStore.getState().setPhase("armed");
      next.settleReady();
    };
    dc.onmessage = (e) => {
      try { handleEvent(next, JSON.parse(e.data as string)); }
      catch (err) { console.error("voice: unreadable event", err); }
    };
    pc.onconnectionstatechange = () => {
      if (session !== next || !pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        teardownSession();
        useVoiceStore.getState().fail("the voice connection dropped");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const resp = await fetch(`${CALLS_URL}?model=${encodeURIComponent(secret.model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret.value}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 300);
      throw new Error(`OpenAI refused the call (${resp.status}): ${detail}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await resp.text() });

    session = next;
    useVoiceStore.getState().setMode(true);
    // A data channel that never opens → failure, not a forever-"connecting" chip.
    setTimeout(() => {
      if (session === next && next.dc.readyState !== "open") {
        teardownSession();
        useVoiceStore.getState().fail("the voice channel never opened");
      }
    }, 10_000);
  } catch (e) {
    try { pc?.close(); } catch { /* already closed */ }
    audioEl?.remove();
    useVoiceStore.getState().fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export function teardownSession(): void {
  const s = session; session = null;
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.settleReady(new Error("the voice session ended"));
  s.responseWaiters.slice().forEach((w) => w());
  s.responseWaiters.length = 0;
  try { s.dc.close(); } catch { /* */ }
  try { s.pc.close(); } catch { /* */ }
  s.mic?.getTracks().forEach((t) => t.stop());
  s.audioEl.remove();
  useVoiceStore.getState().reset();
}

function dcSend(s: LiveSession, payload: unknown): void {
  if (s.dc.readyState === "open") s.dc.send(JSON.stringify(payload));
}

function armIdleTimer(s: LiveSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  const seconds = useVoicePrefs.getState().autoCloseSeconds;
  s.idleTimer = setTimeout(() => {
    if (session !== s) return;
    const store = useVoiceStore.getState();
    if (store.phase === "speaking") { armIdleTimer(s); return; } // never cut mid-playback
    if (store.micOpen) closeMic();                               // close MIC, not session
  }, seconds * 1000);
}

function waitEvent(s: LiveSession, timeoutMs: number): Promise<void> {
  return new Promise<void>((res) => {
    const timer = setTimeout(() => { remove(); res(); }, timeoutMs);
    const waiter = () => { clearTimeout(timer); remove(); res(); };
    const remove = () => { const i = s.responseWaiters.indexOf(waiter); if (i >= 0) s.responseWaiters.splice(i, 1); };
    s.responseWaiters.push(waiter);
  });
}

function restingPhase(): "listening" | "armed" {
  return useVoiceStore.getState().micOpen ? "listening" : "armed";
}

function handleEvent(s: LiveSession, ev: { type?: string } & Record<string, unknown>): void {
  if (session !== s) return;
  armIdleTimer(s);
  const store = useVoiceStore.getState();
  switch (ev.type) {
    case "input_audio_buffer.speech_started": store.setPhase("listening"); break;
    case "output_audio_buffer.started": store.setPhase("speaking"); break;
    case "response.created": s.activeResponses += 1; break;
    case "output_audio_buffer.stopped":
      if (s.endPending) { s.endPending = false; closeMic(); break; }
      store.setPhase(restingPhase()); break;
    case "response.done": {
      s.activeResponses = Math.max(0, s.activeResponses - 1);
      if (s.endPending && store.phase !== "speaking") { s.endPending = false; closeMic(); }
      else if (store.phase !== "speaking") store.setPhase(restingPhase());
      s.responseWaiters.slice().forEach((w) => w());
      break;
    }
    case "response.output_item.done": {
      const item = ev.item as { type?: string; name?: string; call_id?: string; arguments?: string } | undefined;
      if (item?.type === "function_call" && item.name && item.call_id)
        void runToolCall(s, item.name, item.call_id, item.arguments ?? "{}");
      break;
    }
    case "error": console.error("voice: server error event", ev); break; // logged, not fatal
    default: break;
  }
}

async function runToolCall(s: LiveSession, name: string, callId: string, rawArgs: string): Promise<void> {
  if (name === "end_call") {
    s.endPending = true;
    dcSend(s, { type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) } });
    dcSend(s, { type: "response.create" });
    setTimeout(() => { if (session === s && s.endPending) { s.endPending = false; closeMic(); } }, 15_000);
    return;
  }
  let output: unknown;
  try {
    const parsed = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    const helpers = helpersRef;
    if (!helpers) throw new Error("the app is not ready for voice tool calls");
    output = await executeAppControlTool(name, parsed, null, helpers);
  } catch (e) { output = { error: e instanceof Error ? e.message : String(e) }; }
  if (session !== s) return;
  dcSend(s, { type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output ?? null) } });
  dcSend(s, { type: "response.create" });
  armIdleTimer(s);
}

export async function sayAnnouncement(a: FleetAnnouncement): Promise<void> {
  const s = session;
  if (!s) return;
  try { await s.ready; } catch { return; }
  await openMic();                              // open the mic for the reply
  if (session !== s) return;
  const quietBy = Date.now() + 30_000;          // never inject over an active response
  while (session === s && s.activeResponses > 0 && Date.now() < quietBy) await waitEvent(s, 5_000);
  if (session !== s) return;
  dcSend(s, { type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: announcementText(a) }] } });
  dcSend(s, { type: "response.create" });
  armIdleTimer(s);
  const doneBy = Date.now() + 60_000;           // resolve when our response is done (bounded)
  do { await waitEvent(s, 10_000); } while (session === s && s.activeResponses > 0 && Date.now() < doneBy);
}
```

### 13.3 `src/voice/announce.ts` (pure queue + line builder)

```ts
export interface FleetAnnouncement {
  kind: "turn_completed" | "needs_attention";
  conversationId: string;
  title: string;
  outcome?: "success" | "error";
  lastAssistantText?: string | null;
  reason?: "permission" | "question";
  tool?: string | null;
  prompt?: string | null;
  repository?: string | null;
}

/** Structured line handed to the session as a user event message — the agent
 *  rephrases it into one or two spoken sentences. */
export function announcementText(a: FleetAnnouncement): string {
  const where = a.repository ? ` (repo ${a.repository})` : "";
  if (a.kind === "needs_attention") {
    const what = a.reason === "permission"
      ? `is blocked on a permission prompt${a.tool ? ` for the ${a.tool} tool` : ""}`
      : "asked a question and is waiting for an answer";
    const detail = a.prompt ? `\nPrompt: ${a.prompt}` : "";
    return `[Flight Deck event] The conversation "${a.title}"${where} ${what}.${detail}\nTell the user briefly and ask what to answer. conversation_id: ${a.conversationId}`;
  }
  const how = a.outcome === "error" ? "finished its turn WITH AN ERROR" : "finished its turn";
  const detail = a.lastAssistantText ? `\nIts last reply: ${a.lastAssistantText}` : "";
  return `[Flight Deck event] The conversation "${a.title}"${where} ${how}.${detail}\nSummarize that to the user in one or two spoken sentences and ask if they want to reply. conversation_id: ${a.conversationId}`;
}

type Listener = () => void;
const queue: FleetAnnouncement[] = [];
const listeners = new Set<Listener>();
const MAX_QUEUE = 5; // keep the freshest few — never monologue a long backlog

export function queueVoiceAnnouncement(a: FleetAnnouncement): void {
  queue.push(a);
  while (queue.length > MAX_QUEUE) queue.shift();
  listeners.forEach((l) => l());
}
export function nextVoiceAnnouncement(): FleetAnnouncement | null { return queue.shift() ?? null; }
export function pendingVoiceAnnouncements(): number { return queue.length; }
export function onVoiceAnnouncement(l: Listener): () => void { listeners.add(l); return () => listeners.delete(l); }
export function clearVoiceAnnouncements(): void { queue.length = 0; }
```

### 13.4 `src/voice/voiceStore.ts` + `voicePrefs.ts`

`voiceStore` (in-memory runtime state — a session never survives a reload):

```ts
import { create } from "zustand";
export type VoicePhase = "off" | "connecting" | "armed" | "listening" | "speaking" | "error";
interface VoiceState {
  phase: VoicePhase; mode: boolean; micOpen: boolean; error: string | null;
  configured: boolean | null; keyHint: string | null;
  setPhase: (p: VoicePhase) => void; setMode: (m: boolean) => void; setMicOpen: (o: boolean) => void;
  setConfigured: (s: { configured: boolean; key_hint: string | null }) => void;
  fail: (e: string) => void; reset: () => void;
}
export const useVoiceStore = create<VoiceState>((set) => ({
  phase: "off", mode: false, micOpen: false, error: null, configured: null, keyHint: null,
  setPhase: (phase) => set(phase === "off" ? { phase, mode: false, micOpen: false } : { phase, error: null }),
  setMode: (mode) => set(mode ? { mode } : { mode, micOpen: false }),
  setMicOpen: (micOpen) => set({ micOpen }),
  setConfigured: (s) => set({ configured: s.configured, keyHint: s.key_hint }),
  fail: (error) => set({ phase: "error", error, mode: false, micOpen: false }),
  reset: () => set({ phase: "off", error: null, mode: false, micOpen: false }),
}));
```

`voicePrefs` (localStorage; everything defaults toward off/cheap; the KEY is
never here):

```ts
import { create } from "zustand";
import { DEFAULT_PTT, type PttShortcut } from "./pttShortcut";
const STORAGE_KEY = "tosse:voice";
export interface VoicePrefs { autoCloseSeconds: number; pttShortcut: PttShortcut; }
const DEFAULTS: VoicePrefs = { autoCloseSeconds: 25, pttShortcut: DEFAULT_PTT };
export function clampAutoClose(s: number): number {
  if (!Number.isFinite(s)) return DEFAULTS.autoCloseSeconds;
  return Math.min(300, Math.max(10, Math.round(s)));
}
function load(): VoicePrefs {
  try { const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<VoicePrefs>) } : DEFAULTS;
  } catch { return DEFAULTS; }
}
function save(p: VoicePrefs): void { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {} }
interface S extends VoicePrefs { set: (patch: Partial<VoicePrefs>) => void; }
export const useVoicePrefs = create<S>((set) => ({
  ...load(),
  set: (patch) => set((s) => {
    const next: VoicePrefs = {
      autoCloseSeconds: patch.autoCloseSeconds !== undefined ? clampAutoClose(patch.autoCloseSeconds) : s.autoCloseSeconds,
      pttShortcut: patch.pttShortcut ?? s.pttShortcut,
    };
    save(next); return next;
  }),
}));
```

### 13.5 `src/voice/pttShortcut.ts` (pure PTT detectors)

```ts
export interface PttShortcut {
  code: string;            // KeyboardEvent.code — physical key, AZERTY-safe, L/R modifiers
  tap?: boolean;           // modifier-tap mode
  meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean;
}
export const DEFAULT_PTT: PttShortcut = { code: "MetaRight", tap: true };

const MODIFIER_CODES = new Set(["MetaLeft","MetaRight","ShiftLeft","ShiftRight","AltLeft","AltRight","ControlLeft","ControlRight"]);
export function isModifierCode(code: string): boolean { return MODIFIER_CODES.has(code); }

export function describePtt(p: PttShortcut): string {
  const names: Record<string,string> = {
    MetaLeft:"Left ⌘", MetaRight:"Right ⌘", ShiftLeft:"Left ⇧", ShiftRight:"Right ⇧",
    AltLeft:"Left ⌥", AltRight:"Right ⌥", ControlLeft:"Left ⌃", ControlRight:"Right ⌃",
  };
  if (p.tap) return names[p.code] ?? p.code;
  const mods = `${p.ctrl?"⌃":""}${p.alt?"⌥":""}${p.shift?"⇧":""}${p.meta?"⌘":""}`;
  const key = p.code.replace(/^Key/,"").replace(/^Digit/,"");
  return mods ? `${mods} ${key}` : key;
}
export function matchesChord(p: PttShortcut, e: KeyboardEvent): boolean {
  if (p.tap) return false;
  return e.code === p.code && e.metaKey === !!p.meta && e.shiftKey === !!p.shift
      && e.altKey === !!p.alt && e.ctrlKey === !!p.ctrl;
}
/** Clean press-and-release of a modifier with NO other key in between. */
export function makeTapDetector(getShortcut: () => PttShortcut, fire: () => void) {
  let armed = false;
  return {
    keydown(e: KeyboardEvent): void {
      const p = getShortcut(); if (!p.tap) return;
      if (e.code === p.code) armed = true; else if (armed) armed = false; // used in a chord → not a tap
    },
    keyup(e: KeyboardEvent): void {
      const p = getShortcut(); if (!p.tap) return;
      if (e.code === p.code) { if (armed) fire(); armed = false; }
    },
  };
}
export function shortcutFromEvent(e: KeyboardEvent): PttShortcut | null {
  if (e.code === "Escape") return null;
  if (isModifierCode(e.code)) return { code: e.code, tap: true };
  if (!e.code) return null;
  return { code: e.code, meta: e.metaKey || undefined, shift: e.shiftKey || undefined,
           alt: e.altKey || undefined, ctrl: e.ctrlKey || undefined };
}
```

### 13.6 `src/voice/VoiceHost.tsx` (render-null host)

Registers the executor helpers, drains the announcement queue one-at-a-time, and
owns the global PTT listener. Mount it once near the app root.

```tsx
import { useEffect, useRef } from "react";
import { commands } from "../ipc/client";
import type { AppControlHelpers } from "../agent/appControl";
import { clearVoiceAnnouncements, nextVoiceAnnouncement, onVoiceAnnouncement, pendingVoiceAnnouncements } from "./announce";
import { registerVoiceHelpers, sayAnnouncement, toggleMic } from "./realtime";
import { useVoiceStore } from "./voiceStore";
import { useVoicePrefs } from "./voicePrefs";
import { makeTapDetector, matchesChord } from "./pttShortcut";
import type { View } from "../ui/shortcuts";

export function VoiceHost({ changeView, tosseAvailable }: { changeView: (v: View) => void; tosseAvailable: boolean }) {
  const changeViewRef = useRef(changeView); changeViewRef.current = changeView;
  const tosseRef = useRef(tosseAvailable); tosseRef.current = tosseAvailable;

  useEffect(() => {
    const helpers: AppControlHelpers = {
      changeView: (v) => changeViewRef.current(v),
      get tosseAvailable() { return tosseRef.current; },
    };
    registerVoiceHelpers(helpers);
    void commands.voiceAgentStatus().then((res) => {   // seed the shared `configured` mirror
      if (res.status === "ok") useVoiceStore.getState().setConfigured(res.data);
    }).catch((e) => console.error("voice status read failed:", e));
    return () => registerVoiceHelpers(null);
  }, []);

  useEffect(() => {   // push-to-talk listener (live pref read, no re-subscribe)
    const fire = () => { if (useVoiceStore.getState().configured === true) void toggleMic(); };
    const tap = makeTapDetector(() => useVoicePrefs.getState().pttShortcut, fire);
    const onKeyDown = (e: KeyboardEvent) => {
      tap.keydown(e);
      const p = useVoicePrefs.getState().pttShortcut;
      if (!p.tap && matchesChord(p, e) && useVoiceStore.getState().configured === true) { e.preventDefault(); fire(); }
    };
    const onKeyUp = (e: KeyboardEvent) => tap.keyup(e);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  const draining = useRef(false);
  useEffect(() => {   // sequential announcement drain
    async function drain(): Promise<void> {
      if (draining.current) return;
      draining.current = true;
      try {
        for (let a = nextVoiceAnnouncement(); a; a = nextVoiceAnnouncement()) {
          await sayAnnouncement(a);
          const st = useVoiceStore.getState();
          if (!st.mode || st.phase === "error") { clearVoiceAnnouncements(); break; } // stale backlog
        }
      } catch (e) { console.error("voice announcement failed:", e); }
      finally { draining.current = false; if (pendingVoiceAnnouncements() > 0) void drain(); }
    }
    const un = onVoiceAnnouncement(() => void drain());
    if (pendingVoiceAnnouncements() > 0) void drain();
    return un;
  }, []);

  return null;
}
```

### 13.7 The notification producer edit (`useGlobalSessionEvents.ts`)

Inside the app's single "settled notification" function, after computing the
event, enqueue the spoken announcement **only while armed**:

```ts
import { queueVoiceAnnouncement } from "../voice/announce";
import { useVoiceStore } from "../voice/voiceStore";

// … inside fireAgentNotification(convId, kind), after settle/no-op/interrupt filtering:
if (useVoiceStore.getState().mode) {
  queueVoiceAnnouncement(
    kind === "done"
      ? { kind: "turn_completed", conversationId: convId, title: conv.name,
          outcome: meta?.isError ? "error" : "success",
          lastAssistantText: clipForEvent(lastAssistantText(entry)),
          repository: repo ? repoName(repo.path) : null }
      : { kind: "needs_attention", conversationId: convId, title: conv.name,
          reason: pending ? "permission" : "question",
          tool: pending?.tool_name ?? null,
          prompt: clipForEvent(pending?.title ?? pending?.description ?? null),
          repository: repo ? repoName(repo.path) : null },
  );
}
```

**ADAPT**: `clipForEvent`, `lastAssistantText`, `repoName`, `conv`, `repo`,
`pending`, `meta` are host-app helpers/locals — map them to your own agent-event
state. The only requirement: enqueue at the **same** point that already decides
"ping the human", so all channels stay in sync.

---

## 14. Testing notes

- Pure units are unit-testable without a browser: `announce.ts`
  (`announcementText`, queue cap/FIFO), `pttShortcut.ts` (tap detector arms/
  disarms, chord match, `shortcutFromEvent`), and the Rust `voice::key_hint` /
  `validate_key` / `service_name_for`, plus `fs::folder_tree` (git-repo marking,
  no descent, depth bound, loud truncation caps).
- The WebRTC session manager and `getUserMedia` need a live run in the target
  webview — that was the one open probe (verify the mic TCC prompt appears and
  audio plays out).
- Regenerate + commit the typed IPC bindings after adding the 6 commands.

---

*Recreated from `feat/voice-agent`: commits `cbdd52d` (initial), `b847787`
(13-finding hardening), `8bf5a11` (async status), `1cbae08` (two-layer model +
browse_folders + end_call + Right-⌘ PTT).*
