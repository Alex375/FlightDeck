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
// Cost guard: an idle session self-closes after `autoCloseSeconds` without
// activity (Realtime bills per audio minute) — every protocol event re-arms it.

import { commands } from "../ipc/client";
import { executeAppControlTool, type AppControlHelpers } from "../agent/appControl";
import { useVoicePrefs } from "./voicePrefs";
import { useVoiceStore } from "./voiceStore";
import { announcementText, type FleetAnnouncement } from "./announce";

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
  ready: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Resolvers waiting for the next `response.done` (announcement drain). */
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
 *  → stop. */
export async function toggleVoiceSession(): Promise<void> {
  const { micLive } = useVoiceStore.getState();
  if (session) {
    stopVoiceSession();
    // Upgrading an output-only session to push-to-talk: restart with the mic.
    if (!micLive) await startVoiceSession({ withMic: true });
    return;
  }
  await startVoiceSession({ withMic: true });
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
    let mic: MediaStream | null = null;
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
    const pc = new RTCPeerConnection();
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    audioEl.dataset.voiceAgent = "1"; // lets a failed start's orphan be swept
    document.body.appendChild(audioEl);
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0] ?? new MediaStream([e.track]);
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
    const next: LiveSession = {
      pc,
      dc,
      mic,
      audioEl,
      ready,
      idleTimer: null,
      responseWaiters: [],
    };
    dc.onopen = () => {
      // Declare instructions + tools; audio/voice were fixed at mint time.
      dcSend(next, {
        type: "session.update",
        session: { type: "realtime", instructions: INSTRUCTIONS, tools, tool_choice: "auto" },
      });
      useVoiceStore.getState().setPhase(withMic ? "listening" : "saying");
      readyResolve();
    };
    dc.onmessage = (e) => {
      try {
        handleEvent(next, JSON.parse(e.data as string));
      } catch (err) {
        console.error("voice: unreadable event", err);
      }
    };
    pc.onconnectionstatechange = () => {
      if (session !== next) return;
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
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
    // instead of a forever-"connecting" chip.
    setTimeout(() => {
      if (session === next && next.dc.readyState !== "open") {
        stopVoiceSession();
        useVoiceStore.getState().fail("the voice channel never opened");
      }
    }, 10_000);
    void ready.catch(() => {});
    void readyReject; // reserved for symmetric teardown paths
  } catch (e) {
    cleanupDom();
    useVoiceStore.getState().fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Tear the session down (idle timeout, toggle off, connection drop). Safe to
 *  call twice. */
export function stopVoiceSession(): void {
  const s = session;
  session = null;
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.responseWaiters.forEach((w) => w());
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

/** Remove any orphaned audio sink after a failed start. */
function cleanupDom(): void {
  // A failed doStart never assigned `session`, so its element is the only
  // audio sink without a live session; stopVoiceSession removes the live one.
  if (!session) {
    document.querySelectorAll("audio[data-voice-agent]").forEach((el) => el.remove());
  }
}

function dcSend(s: LiveSession, payload: unknown): void {
  if (s.dc.readyState === "open") s.dc.send(JSON.stringify(payload));
}

/** Re-arm the cost guard: close the session after N silent seconds. */
function armIdleTimer(s: LiveSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  const seconds = useVoicePrefs.getState().autoCloseSeconds;
  s.idleTimer = setTimeout(() => {
    if (session === s) stopVoiceSession();
  }, seconds * 1000);
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
    case "output_audio_buffer.stopped":
    case "response.done": {
      store.setPhase(store.micLive ? "listening" : "saying");
      if (ev.type === "response.done") {
        s.responseWaiters.forEach((w) => w());
        s.responseWaiters.length = 0;
      }
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
 * one (no microphone), inject the event as a user message and request a
 * response. Resolves when the response finished, so the caller can drain a
 * queue without the agent talking over itself.
 */
export async function sayAnnouncement(a: FleetAnnouncement): Promise<void> {
  if (!session) await startVoiceSession({ withMic: false });
  const s = session;
  if (!s) return; // start failed; the store carries the error
  await s.ready;
  const done = new Promise<void>((res) => s.responseWaiters.push(res));
  dcSend(s, {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: announcementText(a) }] },
  });
  dcSend(s, { type: "response.create" });
  armIdleTimer(s);
  // Bounded wait: a wedged response must not deadlock the announcement drain.
  await Promise.race([done, new Promise<void>((res) => setTimeout(res, 60_000))]);
}
