// The voice session manager — ONE OpenAI Realtime session over WebRTC, owned
// outside React (same discipline as termManager: components render state from
// voiceStore, they never own the connection).
//
// Shape of a session: mint a short-lived client secret (Rust `voice` module —
// the webview never sees the real key), getUserMedia when push-to-talk (an
// announcement-only session stays OUTPUT-ONLY: no mic, no orange dot), one
// RTCPeerConnection to OpenAI with an "oai-events" data channel for the JSON
// protocol, function tools declared from the SAME catalogue as the MCP servers
// (`app_control_tools`) and executed through the SAME executor
// (`executeAppControlTool`) — a voice command and an in-app agent tool call can
// never mean two different things.
//
// Lifecycle invariants (each one covers a reviewed failure mode):
// - A FAILED start releases everything it acquired — mic tracks, peer
//   connection, audio sink. A hot microphone with the chip showing "error"
//   is the one state this file must never produce.
// - `session.ready` always SETTLES (open → resolve; any teardown → reject), so
//   nothing can park on it forever.
// - The idle cost-guard never fires mid-playback (audio outlives the data
//   channel events), and "disconnected" is transient in WebRTC — only
//   failed/closed tear the session down.

import { commands } from "../ipc/client";
import { executeAppControlTool, type AppControlHelpers } from "../agent/appControl";
import { useVoicePrefs } from "./voicePrefs";
import { useVoiceStore } from "./voiceStore";
import { announcementText, clearVoiceAnnouncements, type FleetAnnouncement } from "./announce";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** The tool subset the voice agent gets — conversation piloting + showing
 *  things on screen. `wait_for_events` excluded (events are PUSHED as spoken
 *  announcements), `whoami` excluded (a voice caller has no own conversation),
 *  `notify_user` excluded (it IS the notification). */
const VOICE_TOOL_NAMES = new Set([
  "list_conversations",
  "read_conversation",
  "send_message",
  "create_conversation",
  "focus_conversation",
  "rename_conversation",
  "open_file",
  "open_view",
  "open_panel",
]);

const INSTRUCTIONS = `You are Flight Deck's voice agent — the cockpit voice for the fleet of coding agents (conversations) the user runs in the Flight Deck desktop app.
Style: spoken and brief — one to three short sentences, unless the user asks you to read details. Match the user's spoken language (this user usually speaks French).
Ground everything in the tools: list_conversations for live statuses, read_conversation before summarizing a reply, send_message to relay the user's answer (name the target conversation before sending when there could be any doubt). Never invent conversation ids or content.
When a [Flight Deck event] message arrives, tell the user what happened in one or two sentences, then ask if they want to react.`;

interface LiveSession {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream | null;
  audioEl: HTMLAudioElement;
  /** Settles when the data channel opens (resolve) or the session tears down
   *  first (reject). ALWAYS settles — see `settleReady`. */
  ready: Promise<void>;
  settleReady: (err?: Error) => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Responses the server is currently generating (`response.created` −
   *  `response.done`), so announcements never talk over an active exchange. */
  activeResponses: number;
  /** One-shot listeners flushed on every `response.done` and on teardown; each
   *  waiter also self-removes on its own timeout (no stale resolvers). */
  responseWaiters: Array<() => void>;
}

let session: LiveSession | null = null;
let starting: Promise<void> | null = null;
let helpersRef: AppControlHelpers | null = null;

/** VoiceHost registers the app helpers (changeView…) the executor needs. */
export function registerVoiceHelpers(helpers: AppControlHelpers | null): void {
  helpersRef = helpers;
}

export function voiceSessionLive(): boolean {
  return session !== null;
}

/** The push-to-talk entry point (header chip + ⌘⇧V): off → start with mic;
 *  live without mic (announcement session) → restart WITH mic; live with mic
 *  → hang up. A start still in flight is awaited first so a press during the
 *  connect window is honoured, never silently swallowed. */
export async function toggleVoiceSession(): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (session) {
    const wasMicless = !useVoiceStore.getState().micLive;
    stopVoiceSession();
    if (wasMicless) {
      // Upgrading an output-only session to push-to-talk: restart with the mic.
      await startVoiceSession({ withMic: true }).catch(() => {});
    } else {
      // A real hang-up: drop the announcement backlog too, or the drain would
      // reopen a session seconds later to finish reading it out.
      clearVoiceAnnouncements();
    }
    return;
  }
  await startVoiceSession({ withMic: true }).catch(() => {});
}

export async function startVoiceSession(opts: { withMic: boolean }): Promise<void> {
  if (session) return;
  if (starting) return starting;
  starting = doStart(opts).finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart({ withMic }: { withMic: boolean }): Promise<void> {
  const store = useVoiceStore.getState();
  store.setPhase("connecting");
  // Hoisted so the catch can release EVERYTHING already acquired: a failed
  // start must never leave a hot mic or an open peer connection behind.
  let mic: MediaStream | null = null;
  let pc: RTCPeerConnection | null = null;
  let audioEl: HTMLAudioElement | null = null;
  try {
    // 1. Short-lived credential + the tool catalogue (single source: Rust).
    const secretRes = await commands.voiceAgentClientSecret();
    if (secretRes.status !== "ok") throw new Error(secretRes.error);
    const secret = secretRes.data;
    const toolsRes = await commands.appControlTools("app");
    if (toolsRes.status !== "ok") throw new Error(toolsRes.error);
    const catalogue = (toolsRes.data as { tools?: Array<Record<string, unknown>> }).tools ?? [];
    const tools = catalogue
      .filter((t) => VOICE_TOOL_NAMES.has(String(t.name)))
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));

    // 2. Microphone only for push-to-talk — never for announcements.
    if (withMic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        throw new Error(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "microphone access was denied — allow it in System Settings → Privacy & Security → Microphone"
            : `microphone unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 3. WebRTC leg. The audio sink must be in the DOM for WebKit to play it.
    pc = new RTCPeerConnection();
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    const sink = audioEl;
    pc.ontrack = (e) => {
      sink.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    if (mic) {
      for (const track of mic.getTracks()) pc.addTrack(track, mic);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    const dc = pc.createDataChannel("oai-events");
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    let readySettled = false;
    const next: LiveSession = {
      pc,
      dc,
      mic,
      audioEl,
      ready,
      settleReady: (err?: Error) => {
        if (readySettled) return;
        readySettled = true;
        if (err) readyReject(err);
        else readyResolve();
      },
      idleTimer: null,
      activeResponses: 0,
      responseWaiters: [],
    };
    // A rejected `ready` is normal teardown; never let it surface as unhandled.
    void ready.catch(() => {});
    dc.onopen = () => {
      // Declare instructions + tools; audio/voice were fixed at mint time.
      dcSend(next, {
        type: "session.update",
        session: { type: "realtime", instructions: INSTRUCTIONS, tools, tool_choice: "auto" },
      });
      useVoiceStore.getState().setPhase(withMic ? "listening" : "saying");
      next.settleReady();
    };
    dc.onmessage = (e) => {
      try {
        handleEvent(next, JSON.parse(e.data as string));
      } catch (err) {
        console.error("voice: unreadable event", err);
      }
    };
    pc.onconnectionstatechange = () => {
      if (session !== next || !pc) return;
      // "disconnected" is TRANSIENT in WebRTC (brief ICE liveness loss that
      // usually self-recovers) — only failed/closed are terminal.
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        stopVoiceSession();
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
    useVoiceStore.getState().setMicLive(withMic);
    armIdleTimer(next);
    // Surface a data-channel that never opens (network middlebox) as a failure
    // instead of a forever-"connecting" chip. stopVoiceSession settles `ready`,
    // so nothing awaiting it can wedge.
    setTimeout(() => {
      if (session === next && next.dc.readyState !== "open") {
        stopVoiceSession();
        useVoiceStore.getState().fail("the voice channel never opened");
      }
    }, 10_000);
  } catch (e) {
    mic?.getTracks().forEach((t) => t.stop());
    try {
      pc?.close();
    } catch { /* already closed */ }
    audioEl?.remove();
    useVoiceStore.getState().fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Tear the session down (idle timeout, toggle off, connection drop). Safe to
 *  call twice. Settles `ready` and flushes every waiter so no async caller can
 *  stay parked on a dead session. */
export function stopVoiceSession(): void {
  const s = session;
  session = null;
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.settleReady(new Error("the voice session ended"));
  s.responseWaiters.slice().forEach((w) => w());
  s.responseWaiters.length = 0;
  try {
    s.dc.close();
  } catch { /* already closed */ }
  try {
    s.pc.close();
  } catch { /* already closed */ }
  s.mic?.getTracks().forEach((t) => t.stop());
  s.audioEl.remove();
  useVoiceStore.getState().reset();
}

function dcSend(s: LiveSession, payload: unknown): void {
  if (s.dc.readyState === "open") s.dc.send(JSON.stringify(payload));
}

/** Re-arm the cost guard. When it fires mid-PLAYBACK (audio keeps flowing on
 *  the media track long after the last data-channel event — that lag is what
 *  `output_audio_buffer.*` exists for), it re-arms instead of hanging up:
 *  cutting an answer mid-sentence to save seconds is the wrong trade. */
function armIdleTimer(s: LiveSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  const seconds = useVoicePrefs.getState().autoCloseSeconds;
  s.idleTimer = setTimeout(() => {
    if (session !== s) return;
    if (useVoiceStore.getState().phase === "speaking") {
      armIdleTimer(s);
      return;
    }
    stopVoiceSession();
  }, seconds * 1000);
}

/** Park until the next `response.done` (or teardown), self-removing on its own
 *  timeout so a stale resolver can never satisfy a LATER caller's wait. */
function waitEvent(s: LiveSession, timeoutMs: number): Promise<void> {
  return new Promise<void>((res) => {
    const timer = setTimeout(() => {
      remove();
      res();
    }, timeoutMs);
    const waiter = () => {
      clearTimeout(timer);
      remove();
      res();
    };
    const remove = () => {
      const i = s.responseWaiters.indexOf(waiter);
      if (i >= 0) s.responseWaiters.splice(i, 1);
    };
    s.responseWaiters.push(waiter);
  });
}

function handleEvent(s: LiveSession, ev: { type?: string } & Record<string, unknown>): void {
  if (session !== s) return;
  armIdleTimer(s);
  const store = useVoiceStore.getState();
  switch (ev.type) {
    case "input_audio_buffer.speech_started":
      store.setPhase("listening");
      break;
    case "output_audio_buffer.started":
      store.setPhase("speaking");
      break;
    case "response.created":
      s.activeResponses += 1;
      break;
    case "output_audio_buffer.stopped":
      store.setPhase(store.micLive ? "listening" : "saying");
      break;
    case "response.done": {
      s.activeResponses = Math.max(0, s.activeResponses - 1);
      if (store.phase !== "speaking") store.setPhase(store.micLive ? "listening" : "saying");
      s.responseWaiters.slice().forEach((w) => w());
      break;
    }
    case "response.output_item.done": {
      const item = ev.item as
        | { type?: string; name?: string; call_id?: string; arguments?: string }
        | undefined;
      if (item?.type === "function_call" && item.name && item.call_id) {
        void runToolCall(s, item.name, item.call_id, item.arguments ?? "{}");
      }
      break;
    }
    case "error":
      // Protocol-level errors are logged, not fatal — the connection state
      // change handler decides when the session is actually dead.
      console.error("voice: server error event", ev);
      break;
    default:
      break;
  }
}

/** Execute one function call through the shared app-control executor and hand
 *  the result back to the model. Errors go back as content too — the agent can
 *  read them out and recover ("that conversation id doesn't exist…"). */
async function runToolCall(
  s: LiveSession,
  name: string,
  callId: string,
  rawArgs: string,
): Promise<void> {
  let output: unknown;
  try {
    const parsed = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    const helpers = helpersRef;
    if (!helpers) throw new Error("the app is not ready for voice tool calls");
    output = await executeAppControlTool(name, parsed, null, helpers);
  } catch (e) {
    output = { error: e instanceof Error ? e.message : String(e) };
  }
  if (session !== s) return; // the session ended while the tool ran
  dcSend(s, {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output ?? null) },
  });
  dcSend(s, { type: "response.create" });
  armIdleTimer(s);
}

/**
 * Speak one fleet announcement: reuse the live session or open an OUTPUT-ONLY
 * one (no microphone), wait for any active exchange to finish (never talk over
 * the user's own response), inject the event and request a response. Resolves
 * when that response is done (bounded), so the caller drains a queue one
 * spoken line at a time. Returns silently when the session cannot start / died
 * mid-way — the error is on the store, and the drain loop stops on it.
 */
export async function sayAnnouncement(a: FleetAnnouncement): Promise<void> {
  if (!session) {
    try {
      await startVoiceSession({ withMic: false });
    } catch {
      return; // start failed; voiceStore carries the error
    }
  }
  const s = session;
  if (!s) return;
  try {
    await s.ready;
  } catch {
    return; // torn down before the channel opened
  }
  // Never inject over an active response (the server rejects a second
  // response.create) — wait for quiet, bounded.
  const quietBy = Date.now() + 30_000;
  while (session === s && s.activeResponses > 0 && Date.now() < quietBy) {
    await waitEvent(s, 5_000);
  }
  if (session !== s) return;
  dcSend(s, {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: announcementText(a) }] },
  });
  dcSend(s, { type: "response.create" });
  armIdleTimer(s);
  // Wait for OUR response to end (bounded): loop until the server is quiet
  // again — the first waitEvent also covers the created→done window.
  const doneBy = Date.now() + 60_000;
  do {
    await waitEvent(s, 10_000);
  } while (session === s && s.activeResponses > 0 && Date.now() < doneBy);
}
