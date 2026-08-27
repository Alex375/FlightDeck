// The voice session manager — ONE OpenAI Realtime session over WebRTC, owned
// outside React (same discipline as termManager: components render state from
// voiceStore, they never own the connection).
//
// TWO-LAYER MODEL (Armand's design):
// - The voice MODE ("session vocale") is ARMED or off — the on-screen toggle.
//   Arming opens the Realtime session with the microphone CLOSED; an armed,
//   silent session exchanges no audio, so it can stay up while the user works.
//   While armed, a fleet event (turn finished / agent waiting) is announced
//   aloud AND the microphone is opened so the user can answer immediately.
// - The MICROPHONE opens and closes WITHIN an armed session: the push-to-talk
//   key (default: Right ⌘ tap) and the mic button toggle it; the silence guard
//   closes the MIC (never the session); the agent's end_call closes the mic
//   when the user says they're done. Closing the mic truly stops the capture
//   (macOS orange dot off): the audio m-line is negotiated up-front
//   (`sendrecv` transceiver) and the track is swapped with `replaceTrack` —
//   attach on open, detach + stop on close, no renegotiation.
//
// Lifecycle invariants (each covers a reviewed failure mode):
// - A FAILED arm releases everything it acquired (mic, peer connection, audio
//   sink) — never a hot mic behind an error chip.
// - `session.ready` always SETTLES (open → resolve; teardown → reject).
// - The silence guard never cuts audio mid-playback; "disconnected" is the
//   transient WebRTC state — only failed/closed tear the session down.

import { commands } from "../ipc/client";
import { executeAppControlTool, type AppControlHelpers } from "../agent/appControl";
import { agentRemoveConversationsEnabled } from "../store/appControl";
import { useVoicePrefs } from "./voicePrefs";
import { useVoiceStore } from "./voiceStore";
import { announcementText, clearVoiceAnnouncements, type FleetAnnouncement } from "./announce";
import { buildTurnDetection } from "./vad";

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
  "browse_folders",
  "focus_conversation",
  "rename_conversation",
  "acknowledge_conversation",
  "remove_conversation",
  "search_past_conversations",
  "reopen_conversation",
  "open_file",
  "open_view",
  "open_panel",
]);

/** Tools the agent only gets when their user policy allows it (read at arm
 *  time, like the app-control spawn gate — re-arm to pick up a change). */
function voiceToolAllowed(name: string): boolean {
  if (name === "remove_conversation") return agentRemoveConversationsEnabled();
  return true;
}

/** Session-local tool (NOT in the shared catalogue): ends the current voice
 *  EXCHANGE — closes the microphone; the armed session stays up for the next
 *  fleet event. */
const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description:
    "Close the microphone and end the current exchange. Call it when the user says they are " +
    "done (« c'est bon », « merci, c'est tout », « raccroche », “that's all”). The voice " +
    "session stays armed — you will still announce future fleet events. Say a brief goodbye " +
    "in your response BEFORE calling it.",
  parameters: { type: "object", properties: {}, required: [] },
};

const INSTRUCTIONS = `You are Flight Deck's voice agent — the cockpit voice for the fleet of coding agents (conversations) the user runs in the Flight Deck desktop app.
Style: spoken and brief — one to three short sentences, unless the user asks you to read details. Match the user's spoken language (this user usually speaks French).
Ground everything in the tools: list_conversations for the LIVE ones on the board, read_conversation before summarizing a reply, send_message to relay the user's answer (name the target conversation before sending when there could be any doubt). When the user refers to a past conversation that isn't on the active list, find it with search_past_conversations and bring it back with reopen_conversation. Never invent conversation ids or content.
When a [Flight Deck event] message arrives, tell the user what happened in one or two sentences, then ask if they want to react — their microphone was just opened for the reply.
Once the user has heard about a conversation and no longer needs it flagged, call acknowledge_conversation to clear its attention highlight. If they ask to clear a conversation off their board, call remove_conversation — it only takes it off the active list (the history is kept and it's undoable), so reassure them nothing is lost.
When the user says they are done with you, say a short goodbye and call end_call. When they ask to work in a folder you don't know, orient yourself with browse_folders before asking them to spell out a path.`;

interface LiveSession {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** The pre-negotiated audio sender; the mic track is swapped in and out with
   *  `replaceTrack` (open/close without renegotiation). */
  micSender: RTCRtpSender;
  /** The live capture stream while the mic is OPEN, null while closed. */
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
  /** `end_call` was invoked: close the MIC once the goodbye finishes playing. */
  endPending: boolean;
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

// ---- Mode (the on-screen "voice session" toggle) ----------------------------

/** Arm or disarm the voice mode. Disarming tears the session down and drops
 *  any queued announcements — off means silence. */
export async function toggleVoiceMode(): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (session) {
    clearVoiceAnnouncements();
    teardownSession();
    return;
  }
  await armVoiceSession().catch(() => {});
}

/** Open the session (mic closed) if it isn't up yet. */
export async function armVoiceSession(): Promise<void> {
  if (session) return;
  if (starting) return starting;
  starting = doStart().finally(() => {
    starting = null;
  });
  return starting;
}

// ---- Microphone (within an armed session) -----------------------------------

/** The push-to-talk entry point (mic button + the customizable key): arms the
 *  mode first if needed, then opens/closes the microphone. */
export async function toggleMic(): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (!session) {
    await armVoiceSession().catch(() => {});
    if (!session) return; // arm failed; the store carries the error
  }
  if (useVoiceStore.getState().micOpen) closeMic();
  else await openMic();
}

/** Attach a live microphone track to the pre-negotiated sender. */
export async function openMic(): Promise<boolean> {
  const s = session;
  if (!s) return false;
  if (useVoiceStore.getState().micOpen) return true;
  try {
    await s.ready;
  } catch {
    return false;
  }
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "microphone access was denied — allow it in System Settings → Privacy & Security → Microphone"
        : `microphone unavailable: ${e instanceof Error ? e.message : String(e)}`;
    useVoiceStore.getState().fail(message);
    teardownSession();
    return false;
  }
  if (session !== s) {
    // The session died while the permission prompt was up.
    mic.getTracks().forEach((t) => t.stop());
    return false;
  }
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

/** Detach AND stop the capture — the orange mic indicator must go off. The
 *  armed session stays up. */
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

/** Push the current VAD threshold to the LIVE session, so the Settings slider
 *  takes effect without re-arming. No-op when nothing is connected (the next
 *  arm reads the pref on `dc.onopen`). */
export function applyVadSettings(): void {
  const s = session;
  if (!s) return;
  dcSend(s, {
    type: "session.update",
    session: {
      type: "realtime",
      audio: { input: { turn_detection: buildTurnDetection(useVoicePrefs.getState().vadThreshold) } },
    },
  });
}

// ---- Session plumbing -------------------------------------------------------

async function doStart(): Promise<void> {
  const store = useVoiceStore.getState();
  store.setPhase("connecting");
  // Hoisted so the catch can release EVERYTHING already acquired: a failed
  // arm must never leave an open peer connection (or capture) behind.
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
    const tools = [
      ...catalogue
        .filter((t) => VOICE_TOOL_NAMES.has(String(t.name)) && voiceToolAllowed(String(t.name)))
        .map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      END_CALL_TOOL,
    ];

    // 2. WebRTC leg — the audio m-line is negotiated up-front (sendrecv) with
    // NO capture: the mic attaches later via replaceTrack. The sink must be in
    // the DOM for WebKit to play it.
    pc = new RTCPeerConnection();
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    audioEl.dataset.voiceAgent = "1";
    document.body.appendChild(audioEl);
    const sink = audioEl;
    pc.ontrack = (e) => {
      sink.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });

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
      micSender: transceiver.sender,
      mic: null,
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
      endPending: false,
    };
    // A rejected `ready` is normal teardown; never let it surface as unhandled.
    void ready.catch(() => {});
    dc.onopen = () => {
      // Declare instructions + tools, and configure turn detection EXPLICITLY
      // (voice/model were fixed at mint time; the input turn_detection was
      // not, so we were inheriting OpenAI's over-sensitive default). The
      // amplitude threshold is user-tunable — see vad.ts / applyVadSettings.
      dcSend(next, {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: INSTRUCTIONS,
          tools,
          tool_choice: "auto",
          audio: { input: { turn_detection: buildTurnDetection(useVoicePrefs.getState().vadThreshold) } },
        },
      });
      useVoiceStore.getState().setPhase("armed");
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
    // Surface a data-channel that never opens (network middlebox) as a failure
    // instead of a forever-"connecting" chip. teardownSession settles `ready`,
    // so nothing awaiting it can wedge.
    setTimeout(() => {
      if (session === next && next.dc.readyState !== "open") {
        teardownSession();
        useVoiceStore.getState().fail("the voice channel never opened");
      }
    }, 10_000);
  } catch (e) {
    try {
      pc?.close();
    } catch { /* already closed */ }
    audioEl?.remove();
    useVoiceStore.getState().fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Tear the whole session down (disarm, connection drop, fatal error). Safe to
 *  call twice. Settles `ready` and flushes every waiter so no async caller can
 *  stay parked on a dead session. */
export function teardownSession(): void {
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

/** Re-arm the silence guard. It closes the MICROPHONE, never the session — an
 *  armed, mic-closed session exchanges no audio and can stay up. Never fires
 *  mid-playback (audio outlives the data-channel events). */
function armIdleTimer(s: LiveSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  const seconds = useVoicePrefs.getState().autoCloseSeconds;
  s.idleTimer = setTimeout(() => {
    if (session !== s) return;
    const store = useVoiceStore.getState();
    if (store.phase === "speaking") {
      armIdleTimer(s);
      return;
    }
    if (store.micOpen) closeMic();
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

/** The phase an idle (non-speaking) session settles back to. */
function restingPhase(): "listening" | "armed" {
  return useVoiceStore.getState().micOpen ? "listening" : "armed";
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
      if (s.endPending) {
        s.endPending = false;
        closeMic();
        break;
      }
      store.setPhase(restingPhase());
      break;
    case "response.done": {
      s.activeResponses = Math.max(0, s.activeResponses - 1);
      // A goodbye that produced no audio at all still ends the exchange here.
      if (s.endPending && store.phase !== "speaking") {
        s.endPending = false;
        closeMic();
      } else if (store.phase !== "speaking") {
        store.setPhase(restingPhase());
      }
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
  if (name === "end_call") {
    // Let the model say its goodbye, then close the MIC when it finishes
    // playing (handleEvent) — with a hard fallback so a silent goodbye can't
    // leave the capture open. The armed session itself stays up.
    s.endPending = true;
    dcSend(s, {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) },
    });
    dcSend(s, { type: "response.create" });
    setTimeout(() => {
      if (session === s && s.endPending) {
        s.endPending = false;
        closeMic();
      }
    }, 15_000);
    return;
  }
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
 * Speak one fleet announcement on the ARMED session: open the microphone so
 * the user can answer immediately (Armand's protocol — the agent solicits and
 * listens), wait for any active exchange to finish, inject the event and
 * request a response. Resolves when that response is done (bounded), so the
 * caller drains a queue one spoken line at a time. Returns silently when the
 * session is not armed / died mid-way — the drain loop stops on the error
 * phase or the disarmed mode.
 */
export async function sayAnnouncement(a: FleetAnnouncement): Promise<void> {
  const s = session;
  if (!s) return; // announcements only exist while the mode is armed
  try {
    await s.ready;
  } catch {
    return; // torn down before the channel opened
  }
  // Open the mic for the reply. A denial degrades to speak-only: the event is
  // still worth hearing.
  await openMic();
  if (session !== s) return;
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
