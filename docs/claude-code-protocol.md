# Claude Code stream-json protocol (v2.1.178) — clean-room client spec

> Authoritative, implementation-ready spec for re-implementing in Rust the **client** of the
> stream-json protocol that drives the `claude` binary (v2.1.178). This is a clean-room spec
> derived from dissecting the bundled VS Code extension (`extension.js`, `webview/index.js`),
> not a fork. Every claim below is grounded in either a minified-bundle byte offset, a quoted
> snippet, or the ground-truth live capture at `/tmp/tosse-proto/capture_text.stdout.jsonl`
> (12 data lines of a real text turn). Claims that adversarial verification **refuted or
> corrected** are flagged inline. In this protocol **we play the SDK role**: we are the client
> that spawns and drives the `claude` binary.

---

## 1. Invocation

### 1.1 The `-p` / `--print` question — DEFINITIVE

**We DO NOT pass `-p`/`--print`.** The binary runs as a **persistent, bidirectional
stream-json session**, not a one-shot. Evidence (verified `confirmed`):
- `grep -aoc '"--print"'` and `grep -aoc '"-p"'` over `extension.js` = **0** (the few `-p`
  regex matches are incidental minified substrings, never argv).
- The argv base array seeds streaming I/O: `extension.js` byte **1012461**:
  `let B=["--output-format","stream-json","--verbose","--input-format","stream-json"];`
- `--input-format stream-json` semantically *requires* a persistent stdin, which is
  incompatible with `-p` one-shot mode.
- The ground-truth capture is a 12-line multi-message stream (system/init → stream_events →
  assistant → result), consistent only with streaming mode.

### 1.2 Literal command line

Spawn the `claude` binary **directly** (it is a self-contained native binary on darwin-arm64;
no `node` needed). Locate it on `PATH` or via configured path. Argv:

```
claude \
  --output-format stream-json \
  --verbose \
  --input-format stream-json \
  --include-partial-messages \
  --permission-prompt-tool stdio \
  [--resume <session_id>]            # only when resuming an existing conversation
  [--fork-session]                   # only when branching a resumed session
  [--allowedTools a,b,c]             # optional, comma-joined static allowlist
  [--disallowedTools d,e]            # optional, comma-joined static denylist
  [--add-dir <path>]...              # repeated once per extra directory
  [--model <id>]                     # optional
```

Notes (all `confirmed`):
- **Flag order** in the reference: the 5-element base array first, then conditional flags. The
  CLI does not parse positionally beyond standard flag parsing; our order need not match
  exactly, but emitting the base array first is safe.
- `--permission-prompt-tool` value is the **literal string `"stdio"`** (extension.js
  ~1013471), NOT a tool name. It is pushed whenever a `canUseTool` callback exists (the
  extension always supplies one). This is the precondition that makes the CLI route permission
  decisions back over the stdio control channel as `control_request{can_use_tool}`. Do **not**
  also register a named MCP permission tool — the two are mutually exclusive.
- `--include-partial-messages` IS passed on local desktop (`includePartialMessages:!remoteName`).
  We want it: it produces the `stream_event` deltas (capture lines 4–11) for live typing.
- `--allow-dangerously-skip-permissions` is the exact flag name (NOT
  `--dangerously-skip-permissions`) if we ever bypass prompts. Do not use it by default.
- `--allowedTools`/`--disallowedTools` are **static comma-joined** spawn flags; `--add-dir` is
  repeated per directory. `can_use_tool` only fires for tools not statically resolved by these.

### 1.3 Session id

- **New session:** pass **no** `--session-id`; the CLI generates the `session_id` and returns
  it in the first `system/init` message. Capture line 1:
  `"session_id":"7f092bc2-ae3c-4e72-8a50-8b1a5bbae805"`.
- **Resume:** pass `--resume <session_id>`. `--continue` is a *distinct* flag (resume the most
  recent), and `--session-id <uuid>` MAY be used to pre-seed an id (corrected: CLI-generation is
  only the *default*, not the only path). `--no-session` disables persistence.
- **Decoy warning** (from verification): the MCP `StdioClientTransport.close()` uses a
  2s+2s SIGTERM/SIGKILL schedule and talks to MCP servers, not the `claude` binary — do not
  copy it as a reference for either argv or termination.

### 1.4 Environment & cwd

- **cwd** = the workspace / repo folder for the conversation.
- **stdio** = `[pipe, pipe, pipe-or-null]`; capture stderr (pipe to our logs) in debug, else
  null. `windowsHide: true` on Windows.
- **env** (merge onto inherited env):
  - `CLAUDE_CODE_ENTRYPOINT` = our own value, e.g. `"tosse-code"` (extension uses
    `"claude-vscode"`; SDK default `"sdk-ts"`).
  - `MCP_CONNECTION_NONBLOCKING` = `"true"`.
  - `CLAUDE_CODE_ENABLE_TASKS` = `"0"`.
  - Strip `NODE_OPTIONS` (avoids contaminating any node fallback).

---

## 2. Process lifecycle & transport

### 2.1 Framing — newline-delimited JSON, both directions (`confirmed`)

- **Outbound (we → CLI, stdin):** every message is `serde_json::to_string(&msg) + "\n"`, one
  JSON object per line. User input, `control_request`, and `control_response` **all share the
  same stdin**. Reference serializer is `Nn(msg)+"\n"` (= `JSON.stringify`), written at offsets
  1029013 / 1036237 / 1039206 / 1040972.
- **Inbound (CLI → we, stdout):** newline-delimited JSON parsed line-by-line via
  `readline.createInterface`. Each non-empty trimmed line is `JSON.parse`d; **non-JSON lines are
  logged and skipped (`continue`), never fatal.** Reference: `for await(let r of e)if(r.trim()){
  try{i=kk(r)}catch{$s("Non-JSON stdout");continue}yield i}`.
- The capture is 12 complete JSON objects, one per line — confirms NDJSON on stdout.

**Rust:** `BufReader::lines()` over stdout; `serde_json::from_str` per line; on error
log+skip. Writer: serialize + `"\n"`, then `flush().await`.

### 2.2 Persistent stdin & write discipline

- `stdin` stays **open for the whole session**; closed only by an explicit `endInput()`/`close()`.
  Never close per-message.
- The reference handles backpressure (logs "Write buffer full, data queued") and buffers
  **pre-spawn writes** in a `pendingWrites` queue, flushing them once the process is ready.
- **Rust:** feed `ChildStdin` from a single `mpsc` channel (so user turns and control responses
  never interleave/tear a line — serialize one full line at a time, awaiting flush). Optionally
  buffer messages issued before spawn completes.

### 2.3 Sending a user message

A user turn is written to stdin as a `user` message in the Anthropic message shape (driven by
an async-iterable `streamInput` loop in the reference). Minimal shape:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
```

(`content` may also be a bare string; blocks are the safe canonical form. Exact required
envelope fields for *inbound* user messages were not pinned from a stdin capture — see §7.)

### 2.4 Interrupt — control channel, NOT a signal (`confirmed`)

`interrupt()` writes a `control_request{subtype:"interrupt"}` to **stdin**; the process **stays
alive**. It is NOT `SIGINT`/`SIGTERM`. Reference: `interrupt(){...this.request({subtype:
"interrupt"})}` and supervisor `interruptClaude` calls `query.interrupt()` with no `kill`.
Map our UI **Stop** button to this control_request, not a kill. (Edge case: if interrupt is
requested before the process is live, the reference aborts the pending launch instead — not a
signal.)

### 2.5 Termination escalation (`confirmed`)

On full session teardown (NOT interrupt):
1. `stdin.end()` (graceful EOF) immediately.
2. Wait **2000 ms** (`OOe=2000`); if still alive → `SIGTERM` (unix).
3. Wait a further **5000 ms**; if still alive → `SIGKILL`.
   (Windows: wait 5000 ms then `SIGKILL`.)

Reference `close()` of the `ProcessTransport` class (offset region ~1015400 / verified bytes).
Register a process-group cleanup so orphans die when Tauri exits.

### 2.6 Resume

See §1.3. Spawn with `--resume <session_id>`; capture the (possibly same) `session_id` from the
new `system/init`. `--fork-session` branches.

---

## 3. Message taxonomy

All messages are top-level JSON objects discriminated by `"type"`. **`tool_use` and `tool_result`
are CONTENT BLOCKS inside `message.content[]`, NEVER top-level types** (`confirmed`). A
`tool_result` is delivered as a top-level **`user`** message whose `message.content[]` holds a
`{type:"tool_result", ...}` block.

### 3.1 Top-level types observed/known

| `type`           | When                          | Source           |
|------------------|-------------------------------|------------------|
| `system`         | init/status/lifecycle         | capture L1,L2    |
| `rate_limit_event` | rate-limit status           | capture L3       |
| `stream_event`   | incremental SSE deltas        | capture L4–L11   |
| `assistant`      | assembled assistant message   | capture L8       |
| `user`           | user turn **and** tool_result delivery | bundle    |
| `result`         | end-of-turn summary           | capture L12      |
| `control_request`  | control channel (§4)        | bundle           |
| `control_response` | control channel (§4)        | bundle           |
| `control_cancel_request` | cancel in-flight control req | bundle    |
| `keep_alive`     | housekeeping — **consume, no reply** | bundle    |
| `transcript_mirror` | housekeeping — consume     | bundle           |

Add a catch-all `Unknown(Value)` (`#[serde(other)]`) for forward-compat.

### 3.2 `system` subtypes (`confirmed`)

Subtypes: `init`, `status`, `compact_boundary`, `model_refusal_fallback`, `task_started`,
`task_progress`, `task_notification`, `thinking_tokens`.

- **`init`** (capture L1) — fields: `cwd`, `session_id`, `tools[]`, `mcp_servers[{name,status}]`,
  `model`, `permissionMode`, `slash_commands[]`, `apiKeySource`, `claude_code_version`,
  `output_style`, `agents[]`, `skills[]`, `plugins[{name,path,source}]`, `analytics_disabled`,
  `product_feedback_disabled`, `uuid`, `memory_paths{auto}`, `fast_mode_state`. Mixed
  camelCase/snake_case — use per-field `#[serde(rename)]`.
- **`status`** (capture L2) — `{status, permissionMode?}` (e.g. `"requesting"`).
- **`compact_boundary`** — `{compact_metadata:{trigger, pre_tokens}}` (snake_case on wire).
- **`task_started`** (`task_type==="local_agent"`), **`task_progress`**, **`task_notification`**
  — sub-agent lifecycle (§3.9). Exact field set medium-confidence (not in capture; see §7).
- **`thinking_tokens`** — `{estimated_tokens}`.

### 3.3 `rate_limit_event` (`confirmed`, capture L3)

```json
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed","resetsAt":1781618400,"rateLimitType":"five_hour",
   "overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},
 "uuid":"...","session_id":"..."}
```
Inner fields are **camelCase** (`resetsAt`, `rateLimitType`, `overageStatus`, `isUsingOverage`)
→ use `#[serde(rename)]`. `status:"allowed"` = no warning.

### 3.4 `stream_event` envelope (`confirmed`, capture L4–L11)

```json
{"type":"stream_event","event":{...SSE event...},
 "session_id":"...","parent_tool_use_id":null,"uuid":"...","ttft_ms":5458}
```
- `ttft_ms` appears **ONLY on the `message_start` event** (L4). Make it `Option`.
- `parent_tool_use_id` is `null` at top level (§3.8). `request_id` is **NOT** present on
  stream_event.

`event.type` values and shapes:
- `message_start` — `{message:<shell with content:[]>}` (L4). The shell carries `model`, `id`,
  `usage`, `stop_reason:null`, etc.
- `content_block_start` — `{index, content_block:<block>}` (L5).
- `content_block_delta` — `{index, delta:<delta>}` (L6,L7).
- `content_block_stop` — `{index}` (L9).
- `message_delta` — `{delta:{stop_reason, stop_sequence, stop_details}, usage, context_management}` (L10).
- `message_stop` — `{}` (L11).

### 3.5 `content_block_delta` delta types (`confirmed`)

Exactly these 6, in this order in the reference accumulator (no others):
`text_delta{text}`, `citations_delta{citation}`, `input_json_delta{partial_json}`,
`thinking_delta{thinking}`, `signature_delta{signature}`, `compaction_delta` (no-op).
Add `#[serde(other)] Unknown` for safety.

**Assembly rule:** accumulate `input_json_delta.partial_json` strings per `index`, then
`JSON.parse` the concatenation into `tool_use.input` at `content_block_stop`. On parse failure,
store the **raw string** as `input` and keep going (graceful). `citations_delta` pushes onto the
text block's `citations[]`. `thinking_delta` is a no-op for `redacted_thinking` blocks.

### 3.6 `assistant` message + the stream-vs-final relationship (CORRECTED)

```json
{"type":"assistant",
 "message":{"model":"...","id":"msg_...","role":"assistant",
   "content":[{"type":"text","text":"hello world"}],
   "stop_reason":null,"usage":{...},"context_management":null},
 "parent_tool_use_id":null,"session_id":"...","uuid":"...","request_id":"req_..."}
```

> **REFUTED / CORRECTED claim:** The earlier claim that "a client may treat `stream_event`s as
> optional and rely on the full assistant message" is **wrong**. Ground truth proves it: the
> top-level `assistant` message (capture L8) is **NOT a complete final-state object** — its
> `stop_reason` is `null` and `usage.output_tokens` is stale (`1`). The authoritative
> `stop_reason` (`"end_turn"`) and final `usage` (`output_tokens:5`) arrive only in the later
> `stream_event{message_delta}` (L10) and `result` (L12).
>
> **Correct model:** treat `stream_event`s as the authoritative *render/assembly* source
> (message_start → content_block_start → content_block_delta → content_block_stop → message_stop).
> The official client renders text from the assembled stream, and uses the top-level `assistant`
> message only as a side-band carrier for usage accounting, model tracking, tool-input snapshots,
> and auth-failure detection. A Rust client **must** consume `message_delta` + `result` for
> correct `stop_reason`/final usage; it MAY use the `assistant` message as a convenient text
> snapshot, but that does not absolve it from the stream/result lines. The `assistant.message.id`
> equals the streamed `message_start.message.id` (`msg_01NvLK19...`) and is the dedup key.

`request_id` (`req_...`) is present on `assistant` and `result` only.

### 3.7 `user` message + `tool_result` delivery (`confirmed`)

A `tool_result` comes back as a top-level `user` message:
```json
{"type":"user","uuid":"...","session_id":"...","parent_tool_use_id":null,
 "message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_...","content":<string|blocks>,"is_error":false}]}}
```
May carry `isSynthetic`. **Correlation:** `tool_result.tool_use_id == tool_use.id`. `content`
can be a `String` OR an array of content blocks → model as untagged enum.

### 3.7.1 Skill / slash-command invocation (`confirmed` on-disk; spec gap in upstream docs)

There is **no dedicated wire type** for "a skill/slash-command ran". Both a user-typed `/foo`
and a model-invoked skill expand into ordinary `user` messages (never `tool_result`, never
`system`). The two entry paths differ:

**User types `/foo` in the composer** → two `user` messages:
1. **Header** — `content` is a **string** opening on the `<command-*>` wrapper, `isMeta` absent:
   ```json
   {"type":"user","uuid":"...","message":{"role":"user",
     "content":"<command-message>done</command-message>\n<command-name>/done</command-name>\n<command-args></command-args>"}}
   ```
2. **Body** — `content` is a **text-block array** opening on `Base directory for this skill:`,
   flagged **`isMeta:true`**:
   ```json
   {"type":"user","uuid":"...","isMeta":true,"message":{"role":"user",
     "content":[{"type":"text","text":"Base directory for this skill: <abs>\n\n# <Title>\n<whole SKILL.md body>"}]}}
   ```

**The MODEL invokes a skill (the `Skill` tool)** → an assistant `tool_use{name:"Skill",
input:{skill,args?}}`, then:
1. a `user` `tool_result` **ack** (`"Launching skill: <skill>"`), `isMeta` absent;
2. the **same body** as above.
   There is **NO `<command-*>` header** here — the `Skill` tool_use *is* the header.

⚠️ **The body's prefix is NOT guaranteed.** The CLI builds it as
`skillRoot ? "Base directory for this skill: " + root + "\n\n" + body : body` — a skill with no
filesystem root injects its SKILL.md **raw**. 27 such bodies (3.5–8.8 KB) exist in real
transcripts (`artifact-design`, `code-review`, `deep-research`, `review`). Re-invoking a skill
already loaded this session injects a one-line notice instead
(`(Re-invocation of /X — the skill instructions were previously loaded…)`). Any guard keyed on
the prefix alone therefore misses a real and recurring share of bodies.

### `isMeta` (disk) vs `isSynthetic` (live) — the general rule

**The CLI renames the flag on the way out.** Every `user` line the binary injects ITSELF is
flagged, but under a different name on each surface:

| surface | field |
|---|---|
| persisted transcript | `isMeta: true` |
| live stdout | `isSynthetic: true` (and **no** `isMeta`) |

VERIFIED against **2.1.217**, both by live probe and by reading the binary: all three
`case"user"` emitters yield `{type:"user", …, isSynthetic: o.isMeta || o.isVisibleInTranscriptOnly}`,
the public zod schema for the `user` type declares `isSynthetic` and no `isMeta`, and the
inverse converter maps `isMeta: t.isSynthetic`. Note it is a **superset** of the disk flag: it
also covers `isVisibleInTranscriptOnly` lines (the `/compact` continuation summary, which on
disk carries `isCompactSummary` + `isVisibleInTranscriptOnly` and **no** `isMeta`).

This covers the skill body AND every other injected line — the `[Image: original WxH, displayed
at WxH…]` note emitted after reading a downscaled image, stop-hook feedback, continuation
nudges, plugin-injected prompts. `sourceToolUseID` remains disk-only and is NOT a live
distinguisher.

**Handling:**
- **Reload** (`history.rs::push_user`): drops `isMeta` **or** `isVisibleInTranscriptOnly` **or**
  `isCompactSummary`.
- **Live** (`assembler.rs::ingest_user`): drops `isSynthetic` (and still honours `isMeta`).
  Applied to the **bubble branch only**, never as an early return — an injected line can also
  carry `tool_result` blocks, which must still be surfaced. The prefix guard
  (`skill_invocation_pending`, armed from `content_block_start` AND the assembled assistant
  message) is kept as belt-and-braces for a future binary that stops sending `isSynthetic`.
- **Neither surface flags** `[Request interrupted by user]`, another command's
  `<local-command-stdout>`, or the `<ide_opened_file>` banner. Those are classified by text in
  `history::classify_injected_text` — one body called from BOTH paths — and become timeline
  notices (or, for the IDE banner, are stripped off the prompt they precede) rather than user
  bubbles or silent drops.

So the SKILL.md **body never renders as a user bubble** (live OR reload). The visible trace is:
for a typed command, the header string → a clean `.cv-cmd` chip (`userText.tsx`); for a model
invocation, the `Skill` tool_use → a dedicated `SkillChip` (from `input.skill`). Fixtures:
`fixtures/capture_skill.jsonl` (on-disk, `isMeta:true`) + `fixtures/capture_skill_live.jsonl`
(live shape, NO `isMeta`); regression tests: `skill_body_user_line_is_dropped`,
`skill_body_line_is_skipped_on_restore`, `skill_invocation_fixture_surfaces_tool_use_not_body`,
`skill_body_live_line_without_ismeta_is_dropped`, `skill_body_drop_does_not_swallow_real_next_turn`,
`synthetic_user_lines_are_dropped`, `skill_body_is_dropped_when_armed_only_from_the_stream`.

⚠️ **The structural guard is the parity table** (`assembler.rs`, `mod parity_tests`): the live
and reload paths are separate code keyed on DIFFERENT fields, so each half can regress to green
alone — which is exactly what happened here (the disk test passed for years while the live
guard was dead code). Any new injected shape belongs in that table.

### 3.8 `parent_tool_use_id` = sub-agent (Task) grouping (`confirmed`)

`parent_tool_use_id` holds the `id` of the `Task` tool_use that spawned a sub-agent; `null` at
top level. It groups all of a sub-agent's stream_events/assistant/user messages. **Aggregate
token usage / "current model" ONLY when `parent_tool_use_id` is null** (avoid double counting).

### 3.9 `result` (`confirmed`, capture L12)

```json
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,
 "duration_ms":5656,"duration_api_ms":6605,"ttft_ms":5586,"ttft_stream_ms":5480,
 "time_to_request_ms":21,"num_turns":1,"result":"hello world","stop_reason":"end_turn",
 "session_id":"...","total_cost_usd":0.124462,
 "usage":{...,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"iterations":[...]},
 "modelUsage":{"claude-opus-4-8[1m]":{"inputTokens":5069,"outputTokens":5,"costUSD":0.123893,
   "contextWindow":1000000,"maxOutputTokens":64000}},
 "permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"..."}
```
- `subtype:"success"` confirmed in ground truth.
- `error_max_turns` / `error_during_execution`: **0 grep hits in both bundles** — the
  extension/webview do not switch on them. Treat exact spellings as **medium-confidence SDK
  constants**, not verified on this CLI's stdout. Use `#[serde(other)] Unknown` to be safe.
- `modelUsage` is a `HashMap<String, ModelUsage>` keyed by model id; **its inner fields are
  camelCase** (`inputTokens`, `costUSD`) while top-level `usage` is snake_case — model both.
- `permission_denials` is read-only (CLI-produced, `[]` in capture); element shape unknown (§7).

### 3.10 Content block types (in `content[]`) (`confirmed`)

`text{text, citations?}`, `thinking{thinking, signature}`, `redacted_thinking{data}`,
`tool_use{id, name, input}`, `server_tool_use{id, name, input}`,
`tool_result{tool_use_id, content, is_error}`, `image{source:{type:"base64", media_type, data}}`,
`document{source}`. Add `#[serde(other)] Unknown`.

### 3.11 `usage` nested shape (`confirmed`)

`{input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, output_tokens,
service_tier, inference_geo}`. `message_delta.usage` adds `output_tokens_details{thinking_tokens}`
and `iterations[]`; `result.usage` adds `server_tool_use{web_search_requests,web_fetch_requests}`.
Make most fields `Option` (they vary by message kind). Do **not** use a single shared flattened
envelope — fields vary per type (`request_id` only on assistant/result, `ttft_ms` only on
message_start).

---

## 4. Control channel

The control channel multiplexes JSON-lines control messages over the **same** stdio stream as
conversation messages. It is **bidirectional** — our core both **sends** and **receives**
`control_request`. This requires **TWO correlation tables**, not one.

### 4.1 Envelopes (`confirmed`)

**`control_request`** (payload nested under `request`, id at top level):
```json
{"request_id":"<token>","type":"control_request","request":{"subtype":"...", ...fields}}
```

**`control_response`** — note the **doubly-nested `response.response`** for success:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<echo>","response":<payload>}}
{"type":"control_response","response":{"subtype":"error","request_id":"<echo>","error":"<string>"}}
```
- `error` is a **string** (from `err.message`), not an object.
- Inbound `control_response` routing keys on **`msg.response.request_id`** (the nested field),
  NOT a top-level id.
- `request_id` is echoed verbatim.

**`control_cancel_request`** `{type:"control_cancel_request", request_id}` aborts an in-flight
**inbound** request (the can_use_tool / dialog we are answering).

### 4.2 `request_id` generation (`confirmed`)

Reference uses `Math.random().toString(36).substring(2,15)` (≤13-char base36). The CLI only
echoes it and never parses its structure → **a monotonic counter is an equally valid, more
debuggable choice** for our client. Any unique string works.

### 4.3 No protocol timeout (`confirmed`)

`request()` wraps no timer. A pending outbound request resolves on a matching `control_response`,
on write failure, or is **rejected en masse on stream cleanup** ("Query closed before response
received"). **Our core must impose its own timeout/abort policy.**

### 4.4 INITIALIZE handshake — direction & timing (`confirmed`)

> **The CLIENT (we) sends `control_request{subtype:"initialize"}` to the CLI immediately at
> startup, right after starting the stdout read loop, NOT gated on `system/init`.** `system/init`
> flows separately through the conversation stream. Send initialize fire-and-forget; await its
> response lazily when you need commands/models/agents.

**Request fields** (all optional for a minimal client — MVP can send `{subtype:"initialize"}`
near-empty): `hooks`, `sdkMcpServers`, `jsonSchema`, `systemPrompt` (string coerced to `[string]`),
`appendSystemPrompt`, `planModeInstructions`, `agents`, `title`, `skills`, `supportedDialogKinds`,
`promptSuggestions`, etc. Hook callbacks are registered locally as `hook_<n>` ids; the CLI later
invokes them via inbound `control_request{subtype:"hook_callback", callback_id, input, tool_use_id}`.

**Response** (`response.response`): at least `{commands, models, agents}` (consumed as opaque
arrays — exact element shapes unknown, §7), optionally `account`. May ALSO carry
`pending_permission_requests` / `pending_user_dialog_requests` arrays which are honored **only on
the initialize response** (ignored with a warn on any other response). Feed
`pending_permission_requests` through the same inbound `can_use_tool` handler.

### 4.5 Outbound control requests we send (`confirmed`)

| subtype | fields | response handling |
|---|---|---|
| `initialize` | see §4.4 | yields commands/models/agents |
| `interrupt` | none | await success, discard payload |
| `set_permission_mode` | `{mode}` | await success |
| `set_model` | `{model}` | await success |
| `mcp_reconnect` / `mcp_toggle` | `{serverName[, enabled]}` | manage MCP servers |

`set_permission_mode` mode enum (exact, `confirmed`): **`["acceptEdits","auto",
"bypassPermissions","default","dontAsk","plan"]`**. (`"bubble"` exists as a UI-only pseudo-mode
superset — treat as UI-only.) `bypassPermissions` is downgraded server-side to `default` unless
`--allow-dangerously-skip-permissions` was set.

### 4.6 Inbound control requests the CLI sends us (`confirmed`)

`can_use_tool` (§5), `hook_callback`, `mcp_message`, `elicitation`, `request_user_dialog`,
plus oauth/host token refresh. We must:
1. Dedupe by `request_id` (skip duplicate delivery of an in-flight id).
2. Register a cancellation token under `request_id` (so `control_cancel_request` can abort it).
3. Run the handler, then write a `control_response{success|error}`.
4. A handler may deliberately emit **no** response via the `suppressControlResponse` sentinel
   (e.g. `request_user_dialog` we cannot settle).

**`mcp_message`** (inbound only): `{subtype:"mcp_message", server_name, message:<JSON-RPC>}`.
For MVP we host **no** SDK MCP servers, so we never advertise `sdkMcpServers` and the CLI will
not send `mcp_message`; if one arrives, reply `error` ("SDK MCP server not found").

### 4.7 Housekeeping types

`keep_alive` and `transcript_mirror` are inbound non-control types: **consume and skip** (no
reply required for `keep_alive`; whether the CLI emits it on a cadence is unconfirmed — §7).

---

## 5. Permission flow (`can_use_tool`)

Enabled by `--permission-prompt-tool stdio` (§1.2). The full round-trip:

### 5.1 Inbound request (`confirmed`, snake_case fields)

```json
{"type":"control_request","request_id":"<id>",
 "request":{"subtype":"can_use_tool","tool_name":"Bash","input":{...},
   "permission_suggestions":[...],"blocked_path":null,"decision_reason":null,
   "title":null,"display_name":null,"description":null,
   "tool_use_id":"toolu_...","agent_id":null}}
```
All request fields are **snake_case**. `input` is the tool input object.

### 5.2 Our response (`confirmed`, camelCase result fields)

Wrap in the standard success envelope; the inner `response` payload is the permission result
**plus `toolUseID`** (camelCase, capital ID — added by the reference client; emit it to match):

**Minimal ALLOW** (echo the input, unchanged if you don't rewrite it):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<echo>",
 "response":{"behavior":"allow","updatedInput":{...originalInput...},"toolUseID":"toolu_..."}}}
```

**Minimal DENY** (`message` is required):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<echo>",
 "response":{"behavior":"deny","message":"<reason>","toolUseID":"toolu_..."}}}
```
Serialize + `"\n"` to stdin.

- ALLOW optional field: `updatedPermissions` (array, default `[]`).
- DENY optional field: `interrupt` (bool) — aborts the turn.
- Result fields are **camelCase** (`behavior`, `updatedInput`, `updatedPermissions`, `message`,
  `interrupt`), in contrast to the snake_case request.
- `behavior:"cancelled"` exists but is only for `request_user_dialog`, NOT `can_use_tool`.
- Note casing mismatch: request field `tool_use_id` (snake) vs response field `toolUseID` (camel).
- Whether `toolUseID` on the inner result is strictly required by the binary is unprovable from
  the bundle (the binary is a black box); correlation is via the envelope `request_id`. Emit it
  anyway to match the reference.

### 5.3 Cancellation & static allowlists

- A `control_cancel_request{request_id}` may arrive to abort a pending prompt — cancel the
  matching handler.
- `--allowedTools`/`--disallowedTools`/`--add-dir` (§1.2) statically resolve some tools so they
  never reach `can_use_tool`; the prompt is the fallback for unresolved tools.
- `permission_denials` in the `result` message records denials (read-only); element shape
  unknown (§7).

---

## 6. Recommended Rust model

### 6.1 Wire types — serde enums internally tagged on `"type"`

```rust
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliMessage {
    System(SystemMsg),
    Assistant(AssistantMsg),
    User(UserMsg),
    Result(ResultMsg),
    StreamEvent(StreamEventMsg),
    RateLimitEvent(RateLimitMsg),
    ControlRequest(ControlRequestEnvelope),
    ControlResponse(ControlResponseEnvelope),
    ControlCancelRequest { request_id: String },
    KeepAlive,
    TranscriptMirror(serde_json::Value),
    #[serde(other)]
    Unknown, // forward-compat
}

#[derive(Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemMsg {
    Init(Box<InitMsg>),
    Status { status: Option<String>,
             #[serde(rename = "permissionMode")] permission_mode: Option<String> },
    CompactBoundary { compact_metadata: CompactMeta },
    ModelRefusalFallback(serde_json::Value),
    TaskStarted(serde_json::Value),
    TaskProgress(serde_json::Value),
    TaskNotification(serde_json::Value),
    ThinkingTokens { estimated_tokens: u64 },
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEventInner {
    MessageStart { message: serde_json::Value },
    ContentBlockStart { index: u32, content_block: ContentBlock },
    ContentBlockDelta { index: u32, delta: ContentDelta },
    ContentBlockStop { index: u32 },
    MessageDelta { delta: MsgDelta, usage: Usage, context_management: serde_json::Value },
    MessageStop,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentDelta {
    TextDelta { text: String },
    CitationsDelta { citation: serde_json::Value },
    InputJsonDelta { partial_json: String },
    ThinkingDelta { thinking: String },
    SignatureDelta { signature: String },
    CompactionDelta,
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String, #[serde(default)] citations: Option<Vec<serde_json::Value>> },
    Thinking { thinking: String, signature: String },
    RedactedThinking { data: String },
    ToolUse { id: String, name: String, input: serde_json::Value },
    ServerToolUse { id: String, name: String, input: serde_json::Value },
    ToolResult { tool_use_id: String, content: ToolResultContent, #[serde(default)] is_error: bool },
    Image { source: ImageSource },
    Document { source: serde_json::Value },
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent { Text(String), Blocks(Vec<ContentBlock>) }
```

Control envelopes (note the doubly-nested success payload):
```rust
#[derive(Deserialize)]
pub struct ControlRequestEnvelope { pub request_id: String, pub request: ControlRequestBody }

#[derive(Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequestBody {
    CanUseTool(CanUseToolReq),
    HookCallback(serde_json::Value),
    McpMessage { server_name: String, message: serde_json::Value },
    Elicitation(serde_json::Value),
    RequestUserDialog(serde_json::Value),
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
pub struct CanUseToolReq {
    pub tool_name: String,
    pub input: serde_json::Value,
    #[serde(default)] pub permission_suggestions: Option<Vec<serde_json::Value>>,
    #[serde(default)] pub blocked_path: Option<String>,
    #[serde(default)] pub decision_reason: Option<serde_json::Value>,
    #[serde(default)] pub title: Option<String>,
    #[serde(default)] pub display_name: Option<String>,
    #[serde(default)] pub description: Option<String>,
    pub tool_use_id: String,
    #[serde(default)] pub agent_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ControlResponseEnvelope { pub response: ControlResponseBody }

#[derive(Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlResponseBody {
    Success { request_id: String, response: serde_json::Value },
    Error { request_id: String, error: String },
}

// Outbound permission result (camelCase!)
#[derive(Serialize)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum PermissionResult {
    Allow { #[serde(rename = "updatedInput")] updated_input: serde_json::Value,
            #[serde(rename = "updatedPermissions", skip_serializing_if = "Vec::is_empty")]
            updated_permissions: Vec<serde_json::Value>,
            #[serde(rename = "toolUseID")] tool_use_id: String },
    Deny { message: String,
           #[serde(skip_serializing_if = "Option::is_none")] interrupt: Option<bool>,
           #[serde(rename = "toolUseID")] tool_use_id: String },
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")] // wire tokens exactly: acceptEdits, auto, ...
pub enum PermissionMode { AcceptEdits, Auto, BypassPermissions, Default, DontAsk, Plan }
```

### 6.2 Supervisor architecture

```
                 ┌──────────────── ProcessSupervisor (per session) ────────────────┐
                 │                                                                  │
  spawn claude → │  ChildStdin  ←── writer task ←── mpsc<OutboundLine>              │
                 │  ChildStdout ──→ reader task ──→ classify by top-level "type"    │
                 │  ChildStderr ──→ log task                                        │
                 │                                                                  │
                 │  reader routes:                                                  │
                 │    control_response   → outbound table: HashMap<id, oneshot::Sender<Result<Value,String>>>
                 │    control_request    → inbound table:  HashMap<id, CancellationToken>; spawn handler
                 │    control_cancel_request → cancel inbound token                  │
                 │    keep_alive/transcript_mirror → drop                           │
                 │    conversation types → assembler → emit IPC events to UI        │
                 └──────────────────────────────────────────────────────────────────┘
```

- **Reader task:** `BufReader::lines()`; `from_str` per line; log+skip parse errors.
- **Writer task:** owns `ChildStdin`; single `mpsc` so user turns and control responses never
  tear a line; serialize + `"\n"` + `flush().await`. Buffer pre-spawn writes.
- **Outbound control table:** `HashMap<String, oneshot::Sender<Result<Value,String>>>`. Insert
  *before* writing the request. On `control_response`, look up by `response.request_id`, resolve
  `Ok`/`Err` by `subtype`. **Impose our own timeout** (no protocol timer).
- **Inbound control table:** `HashMap<String, CancellationToken>`. Dedupe by `request_id`; on
  `control_cancel_request` cancel; for `can_use_tool` surface to UI and answer with
  `control_response` (§5).
- **State machine per session:** `Spawning → Initializing (initialize sent) → Idle → Running
  (turn in flight) → AwaitingPermission → Idle → ... → Terminating`. Track `busy` from
  `system/init` (busy=true) and `result` (busy=false); `status`/`permissionMode` from
  `system/status`.
- **Assembler:** keyed by `(session, parent_tool_use_id ?? "root", message.id, block_index)`.
  Apply deltas (§3.5); parse `input_json` at `content_block_stop`; merge `tool_use`↔`tool_result`
  by id into one normalized tool entry (do this in Rust so the UI never matches ids). Treat the
  top-level `assistant` message as a side-band snapshot; take authoritative `stop_reason`/usage
  from `message_delta` + `result` (per §3.6 correction). Only aggregate usage when
  `parent_tool_use_id` is null (§3.8).
- **Sub-agents:** track a `subagentTasks` map keyed by `task_id` from
  `task_started`/`task_progress`/`task_notification`; emit as separate nested events.

### 6.3 tauri-specta IPC surface

Tie into the existing scaffolding pattern in `src-tauri/src/lib.rs`
(`Builder::<Wry>::new().commands(collect_commands![...]).events(collect_events![...])`,
`#[tauri::command] #[specta::specta]`, `#[derive(..., Type)]`, events `#[derive(..., Type, Event)]`
emitted via `Event::emit`). Extend it:

```rust
// commands.rs
#[tauri::command] #[specta::specta]
pub async fn spawn_session(repo_path: String, resume: Option<String>,
                           state: tauri::State<'_, Sessions>) -> Result<SessionId, String>;

#[tauri::command] #[specta::specta]
pub async fn send_message(session: SessionId, text: String,
                          state: tauri::State<'_, Sessions>) -> Result<(), String>;

#[tauri::command] #[specta::specta]
pub async fn answer_permission(session: SessionId, request_id: String,
                               decision: PermissionDecision,
                               state: tauri::State<'_, Sessions>) -> Result<(), String>;

#[tauri::command] #[specta::specta]
pub async fn set_permission_mode(session: SessionId, mode: PermissionMode,
                                 state: tauri::State<'_, Sessions>) -> Result<(), String>;

#[tauri::command] #[specta::specta]
pub async fn interrupt_session(session: SessionId,
                               state: tauri::State<'_, Sessions>) -> Result<(), String>;

#[tauri::command] #[specta::specta]
pub async fn stop_session(session: SessionId,
                          state: tauri::State<'_, Sessions>) -> Result<(), String>;

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow { updated_input: Option<serde_json::Value> },
    Deny  { message: String },
}
```

```rust
// events.rs  (derive Type + Event; emit via Event::emit like TickEvent)
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionMessageEvent {       // normalized, UI renders dumb
    pub session: String,
    pub message: NormalizedMessage,    // role, blocks[], beta_message_id, parent_tool_use_id, ...
}

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionStateEvent {
    pub session: String,
    pub busy: bool,
    pub status: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub session_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct PermissionRequestEvent {    // surface a can_use_tool to the UI
    pub session: String,
    pub request_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub title: Option<String>,
    pub description: Option<String>,
    pub suggestions: Option<Vec<serde_json::Value>>,
}
```

Register: `.commands(collect_commands![ping, spawn_session, send_message, answer_permission,
set_permission_mode, interrupt_session, stop_session])` and `.events(collect_events![TickEvent,
SessionMessageEvent, SessionStateEvent, PermissionRequestEvent])`. `u64`/`i64` already export to
TS `number` via the configured `BigIntExportBehavior::Number` (safe for ms timestamps; switch to
String if a field can exceed 2^53). The `Sessions` map is held as Tauri managed state.

> **Normalize in Rust, keep React dumb.** Unlike the official extension (which forwards raw
> stream-json inside a `{type:"from-extension", message:{type:"io_message", channelId, message,
> done}}` double envelope and assembles in the webview — see the rendering-model correction
> below), we should do all assembly/merging in the Rust core and emit pre-normalized typed events.
> The correction matters for de-risking: the host is **not** a pure passthrough — it also adds a
> `channelId`/`done` routing layer and intercepts `system/bridge_state` (remote-control) messages
> it never forwards. We should mirror that: carry a `session` id + `done` flag on our events, and
> reserve a control-message class the core consumes rather than relays.

---

## 7. Open questions & risks

**Version-fragility (v2.1.178-specific):** everything here is pinned to this CLI build. The
single strongest de-risking lever is a **fixture-based test**: assert our serde round-trips the
checked-in `/tmp/tosse-proto/capture_text.stdout.jsonl` losslessly, line-by-line, into our enums
(no `Unknown` for known lines). Re-capture and re-run on every `claude` upgrade.

Unverified / low-confidence items, with how to de-risk:

1. **Inbound user-message envelope shape.** §2.3 gives the rendered `user` text shape but the
   exact required fields for messages we *write* to stdin were not captured from stdin.
   *De-risk:* capture a real session's stdin (e.g. tee), or test empirically against the binary.
2. **`result` error subtypes** (`error_max_turns`, `error_during_execution`): **0 grep hits** in
   both bundles; spellings are SDK constants, unverified on this CLI's stdout. *De-risk:* force a
   `--max-turns 1` overflow and a mid-execution error, capture the lines. Keep `#[serde(other)]`.
3. **`initialize` response element shapes** (`commands[]`, `models[]`, `agents[]`): consumed as
   opaque in the bundle. *De-risk:* capture a live `initialize` `control_response` from stdout.
   Keep them as `serde_json::Value` until pinned.
4. **`can_use_tool` inner shapes** (`permission_suggestions` element schema, `decision_reason`,
   `updatedPermissions` element schema, whether `toolUseID` is strictly required): not exercised
   in the text-only capture. *De-risk:* capture a real permission turn (run a Bash/Write tool in
   `default` mode).
5. **`result.permission_denials` element shape:** `[]` in capture; CLI-produced, no bundle ref.
   *De-risk:* capture a turn with at least one denial.
6. **Sub-agent system subtypes** (`task_started`/`task_progress`/`task_notification`) and
   `tool_progress.repl_call`: referenced in webview but not in capture. *De-risk:* run a `Task`
   tool and capture.
7. **`keep_alive` cadence / reply obligation:** bundle only shows it consumed (`continue`),
   implying no reply. *De-risk:* a long-idle live capture to confirm no reply is needed and learn
   the interval.
8. **stdin backpressure semantics:** reference logs "Write buffer full" and queues; whether it
   awaits `drain` is unconfirmed. *De-risk:* in Rust, always `flush().await` after each line and
   use a bounded channel to apply natural backpressure.
9. **`--replay-user-messages`:** not passed in our harness; if we enable it the stdout stream may
   gain echoed user lines (could help canonical rendering). *De-risk:* capture with the flag on
   before relying on it.
10. **`redacted_thinking.data` field name:** inferred from Anthropic API convention, not seen in
    capture. *De-risk:* capture a redacted-thinking turn. Keep as `Value` if uncertain.

**Refuted claims explicitly NOT propagated:**
- "Client may treat `stream_event`s as optional and rely on the full `assistant` message" —
  **REFUTED** (capture L8 has `stop_reason:null`, stale usage). See §3.6. The stream + `result`
  are authoritative for `stop_reason`/usage.
- "Webview receives raw messages wrapped *only* as `{type:'from-extension', message}`" —
  **CORRECTED**: there is a double envelope with a `channelId`/`done` routing layer
  (`io_message`), and the host filters `system/bridge_state` and is not a pure passthrough. See
  §6.3.
- Permission response "minimal allow/deny is just `{behavior,...}`" — **CORRECTED**: the
  reference also appends `toolUseID` to the inner payload (§5.2); emit it.
