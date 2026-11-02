// The Machine row of the conversation side panel — WHERE a conversation runs (this Mac, or a
// paired server) and, for a server, the ONE fact about it that matters most right now. Pure: the
// row (`features/conversation/widgets/MachineRow.tsx`) only renders what this module decides, so
// the priority between the facts is pinned by tests rather than by JSX.
//
// Every fact comes from a signal that already exists — nothing here dials anything:
//  - WHERE: `Repo.machineId` → a paired `Machine` (a conversation has no machine of its own).
//  - HEALTH: `store/machineHealth.ts`, fed by the ambient sweep (`MachineHealthHost`), the live
//    triggers and the Settings server panel.
//  - LINK: `SessionStatePayload.link`, the live ssh link of a spawned remote session.
//
// The same rules as the remote mark (`RemoteRepoMark.tsx`), which this row must never contradict:
//  - ⚠️ A `machineId` naming no paired machine is an UNKNOWN SERVER (amber), never "local": the
//    folder is still on a server, and reading it as this Mac is the exact confusion the mark
//    exists to end.
//  - ⚠️ UNKNOWN IS NOT REACHABLE. A missing health row, or one that only ever recorded a probe
//    error (`checkedAtMs === 0`), is no verdict — it reads an em dash, never "Reachable".
//  - COLOUR IS RESERVED FOR HEALTH. Reachable and connected stay quiet (no green at rest); amber
//    is a link that dropped or a server we cannot name; red is a server checked and found out of
//    reach.
//  - `reason` is the backend's wording, shown VERBATIM and never matched on.
import type { RemoteLinkState, SessionStatePayload } from "../../ipc/client";
import { remoteLinkFailure, remoteLinkView, type RemoteLinkView } from "../../agent/remoteLink";
import type { Machine, Repo } from "../../store/conversationsStore";
import { isUnreachable, type MachineHealth } from "../../store/machineHealth";
import { remoteMarkFor } from "./RemoteRepoMark";
import { checkedPhrase, lastReachedLine, lastReachedPhrase } from "./serverFault";
import { MACHINE } from "../../ui/platform";

export { checkedPhrase };

/** The live ssh link of the conversation's session, as far as this row cares. */
export type MachineLink =
  /** No live session: the stream is off (remote conversations spawn lazily, so this is the
   *  resting state). */
  | { kind: "off" }
  /** A Codex conversation: remote (SSH) conversations are Claude-only, and the spawn REFUSES a
   *  Codex one in a server's folder ("Remote (SSH) conversations are Claude-only for now.") —
   *  it never has a link, and never will. Only meaningful on a remote row (a local Codex
   *  conversation never asks for its link). */
  | { kind: "unsupported" }
  /** A session handle exists but no session id yet: the neutral entry a fresh spawn starts
   *  from, before its first real state event. NOT attached (same guard as
   *  `attachedMachineIds`). */
  | { kind: "starting" }
  /** Never attached yet this session, or attached before and lost it — with what the core is
   *  doing about it (see `RemoteLinkState`). Flat primitives, so the row's shallow selector stays
   *  stable across the session's unrelated state events. */
  | ({ kind: "connecting" | "reconnecting" } & LinkDown)
  /** The link is up — proof the server is there, without a probe. */
  | { kind: "attached" }
  /** The session ended (its link was cleared with it). */
  | { kind: "ended" }
  /** The last session gave up on the link for good — this Mac's key refused, the server's
   *  identity changed, its daemon missing — with the core's own sentence for it. The stream
   *  reads "off", but the next message would hit the same wall: it must not read as merely
   *  off and "connecting with your next message". */
  | { kind: "failed"; message: string };

/** A link that is down, as `RemoteLinkState` carries it: `attempt` failed attempts this outage (1
 *  at a reconnect's first drop), since when, and the next attempt's due time (`null` = dialing). */
export interface LinkDown {
  attempt: number;
  sinceMs: number;
  retryAtMs: number | null;
  slowed: boolean;
}

/** The core's own shape back, for the shared link voice (`agent/remoteLink.ts`). */
function linkStateOf(link: { kind: "connecting" | "reconnecting" } & LinkDown): RemoteLinkState {
  return {
    kind: link.kind,
    attempt: link.attempt,
    since_ms: link.sinceMs,
    retry_at_ms: link.retryAtMs,
    slowed: link.slowed,
  };
}

/** What a remote row's link is doing right now, in the shared link voice — `null` unless it is
 *  down. `online`: this Mac's network (an offline Mac is not an unreachable server). */
export function machineLinkView(view: MachineView, nowMs: number, online = true): RemoteLinkView | null {
  if (view.kind !== "remote") return null;
  const { link } = view;
  if (link.kind !== "connecting" && link.kind !== "reconnecting") return null;
  return remoteLinkView(linkStateOf(link), nowMs, { server: view.label, online });
}

/** What the health store knows about the machine. */
export type MachineReach =
  /** No verdict: never checked in this app run, or every check failed to even run. */
  | { kind: "unknown"; probeError: string | null }
  | { kind: "reachable"; health: MachineHealth }
  | { kind: "unreachable"; health: MachineHealth };

/** Where the conversation runs, and what we know about it. */
export type MachineView =
  | { kind: "local" }
  /** `machineId` set but naming no paired machine (the pairing was deleted). Still remote. */
  | { kind: "unknown" }
  | {
      kind: "remote";
      machineId: string;
      label: string;
      /** `user@host:port` — the paired address, which can lag an address rotation until the
       *  next launch, so it is presented as "paired as", never as "connected via". */
      target: string;
      reach: MachineReach;
      link: MachineLink;
    };

/** The sub-line's colour. `lo` is the quiet default; the other two are health. */
export type MachineTone = "lo" | "att" | "err";

/** The repo's machine: `null` for a folder on this Mac, the machine id for a server, and
 *  `undefined` when the conversation's repo is not in the store at all — which is no answer, so
 *  the row renders nothing rather than guessing "local". A primitive on purpose: it is what the
 *  row's store selector returns, so it re-renders only when the ANSWER changes.
 *
 *  An empty id is this Mac, exactly as `remoteMarkFor` (`!machineId`) and the health host
 *  (`!!id`) read it — otherwise the row would take the remote branch for a folder every other
 *  surface calls local, and title it "Unknown server". */
export function machineIdOf(
  repos: ReadonlyArray<Pick<Repo, "id" | "machineId">>,
  repoId: string,
): string | null | undefined {
  const repo = repos.find((r) => r.id === repoId);
  if (!repo) return undefined;
  return repo.machineId || null;
}

/**
 * The link state of a conversation's session. Pure; the returned object has primitive fields
 * only, so a `useShallow` selector keeps it stable across the session's unrelated state events
 * (busy flips, model read-backs…).
 *
 * `codex`: a Codex conversation never has a remote link (remote is Claude-only; the spawn refuses
 * it), and its LOCAL session reports `link: null` like an attached one — it must not read as
 * "Connected" to a server, so it is always `unsupported` here, handle or not. Nor may it read
 * "off": that promises a connection with the next message, which the spawn will refuse.
 */
export function machineLinkOf(
  handle: string | null | undefined,
  state: Pick<SessionStatePayload, "ended" | "link" | "session_id" | "end_reason" | "end_detail"> | undefined,
  backend: "claude" | "codex" = "claude",
): MachineLink {
  if (backend === "codex") return { kind: "unsupported" };
  if (!handle) {
    // The handle is unbound the moment a session ends: what it ended ON is in its last state.
    const failure = remoteLinkFailure(state);
    return failure ? { kind: "failed", message: failure } : { kind: "off" };
  }
  if (!state) return { kind: "starting" };
  if (state.ended) return { kind: "ended" };
  if (state.link) {
    const { kind, attempt, since_ms, retry_at_ms, slowed } = state.link;
    return { kind, attempt, sinceMs: since_ms, retryAtMs: retry_at_ms, slowed };
  }
  // ⚠️ `link: null` alone is not "attached": the neutral entry a fresh spawn starts from has it
  // too. The session id is what proves a real state event landed.
  if (state.session_id == null) return { kind: "starting" };
  return { kind: "attached" };
}

/** Fold a health row into a verdict. ⚠️ Never reads `reachable` alone: a row that only ever
 *  recorded a probe error carries `reachable: true` with `checkedAtMs: 0` — "we failed to ask",
 *  not "it answered". */
export function machineReachOf(health: MachineHealth | undefined): MachineReach {
  if (!health || health.checkedAtMs <= 0) return { kind: "unknown", probeError: health?.probeError ?? null };
  if (isUnreachable(health)) return { kind: "unreachable", health };
  return { kind: "reachable", health };
}

/**
 * Everything the row shows, derived once.
 *
 * `machineId` null/undefined is this Mac. Otherwise the machine is resolved against the paired
 * list through `remoteMarkFor`, so the row and the mark can never disagree about which server —
 * or about an unpaired one being unknown rather than local.
 */
export function machineWidgetState(input: {
  machineId: string | null | undefined;
  machines: Machine[];
  health: MachineHealth | undefined;
  link: MachineLink;
}): MachineView {
  const { machineId, machines, health, link } = input;
  if (!machineId) return { kind: "local" };
  const mark = remoteMarkFor(machineId, machines);
  if (mark.kind === "local") return { kind: "local" };
  if (mark.kind === "unknown") return { kind: "unknown" };
  return {
    kind: "remote",
    machineId,
    label: mark.label,
    target: mark.target,
    reach: machineReachOf(health),
    link,
  };
}

/** The TanStack Query key of this Mac's Computer Name (`commands.localMachineName`, read once
 *  per app run by the backend). Exported so a boot-time prefetch shares the row's cache entry. */
export const LOCAL_MACHINE_NAME_KEY = ["localMachineName"] as const;

/** The local row's two lines. The Computer Name when the backend could read it, with "This Mac"
 *  under it; otherwise "This Mac" itself, with "Local" under it — never the same words twice.
 *  `undefined` (still loading, or the lookup failed) reads like `null`: both are true. */
export function localMachineText(name: string | null | undefined): { title: string; sub: string } {
  const n = name?.trim();
  return n ? { title: n, sub: `This ${MACHINE}` } : { title: `This ${MACHINE}`, sub: "Local" };
}

/**
 * The sub-line: the ONE most important fact, most urgent first.
 *
 *  1. A reconnect the user asked for that FAILED (`reconnectError`, red) — the answer to their
 *     own gesture, never swallowed. Then a Codex conversation (amber): it cannot run on a server
 *     at all, whatever the server's health.
 *  2. The link dropped (amber) or is being established — in the shared link voice: an attempt
 *     dialing now, or how long until the next one (`agent/remoteLink.ts`).
 *  3. The last session gave up on the link (red, the core's own sentence) — then this Mac being
 *     offline (amber): with no network every check fails, so it outranks the verdict below,
 *     which would otherwise blame the server.
 *  4. The server was checked and is out of reach (red, the backend's reason verbatim).
 *  5. The link is up ("Connected" — quiet: working is the expected case).
 *  6. The last check could not even run (quiet, its error) — the newest fact once it happened:
 *     a "Check now" that failed must not leave the row exactly as it was, and a verdict that
 *     stops being refreshed would otherwise just age without saying why.
 *  7. The last verdict and its age, or — with no verdict — "Checking…" while a probe is out, or
 *     an em dash.
 *
 * A DOWN link outranks the verdict: it is live and per-session, the verdict at best one sweep
 * old. An UP link does not outrank "unreachable": the attach edge files a fresh "reachable" at
 * once (`useGlobalSessionEvents`), so the two only meet when a check run AFTER the attach failed
 * — a new dial that did not get through, which the next reconnect would hit too. The tooltip
 * carries every fact the sub-line had to leave out.
 */
export function machineSubLine(
  view: MachineView,
  opts: {
    nowMs: number;
    probing?: boolean;
    reconnectError?: string | null;
    localName?: string | null;
    online?: boolean;
  },
): { text: string; tone: MachineTone } {
  if (view.kind === "local") return { text: localMachineText(opts.localName).sub, tone: "lo" };
  if (view.kind === "unknown") return { text: "No longer paired", tone: "lo" };
  if (opts.reconnectError) return { text: `Reconnect failed · ${opts.reconnectError}`, tone: "err" };
  const { link, reach } = view;
  // Whatever the server's health, this conversation cannot run there: that is the fact to know
  // before typing to it (amber, like a server we cannot name — a fault, not a health verdict).
  if (link.kind === "unsupported") return { text: "Codex can't run on a server", tone: "att" };
  const down = machineLinkView(view, opts.nowMs, opts.online);
  if (down) {
    // A first dial is the expected path, said quietly; anything past it is a fact to notice.
    const quiet = link.kind === "connecting" && down.phase === "dialing" && link.attempt === 0;
    return { text: down.short, tone: quiet ? "lo" : "att" };
  }
  if (link.kind === "failed") return { text: `Link failed · ${link.message}`, tone: "err" };
  if (opts.online === false) return { text: `This ${MACHINE} is offline`, tone: "att" };
  // With its age: a verdict from a check minutes ago is not news of now.
  if (reach.kind === "unreachable") {
    const why = reach.health.reason ?? "Unreachable";
    return { text: `${why} · checked ${checkedPhrase(reach.health, opts.nowMs)}`, tone: "err" };
  }
  if (link.kind === "attached") return { text: "Connected", tone: "lo" };
  // Not the server's fault, and not a verdict: said in the quiet tone, but said — a check the
  // user may just have asked for must not end in silence. `probeError` is cleared by the next
  // check that completes, so it never outlives the failure it reports.
  const probeError = reach.kind === "unknown" ? reach.probeError : reach.health.probeError;
  if (probeError && !opts.probing) return { text: `Could not check · ${probeError}`, tone: "lo" };
  if (reach.kind === "reachable") return { text: `Reachable · checked ${checkedPhrase(reach.health, opts.nowMs)}`, tone: "lo" };
  if (opts.probing) return { text: "Checking…", tone: "lo" };
  return { text: "—", tone: "lo" };
}

/**
 * The tooltip: the machine's name, then every fact as one line each — the paired address, the
 * link, the verdict with its age, and when it was last reached. The first entry is the heading.
 */
export function machineTipLines(view: MachineView, nowMs: number, online = true): string[] {
  if (view.kind === "local") return [`This ${MACHINE}`, `Conversations in this folder run on this ${MACHINE}`];
  if (view.kind === "unknown") {
    return [
      "Unknown server",
      "This folder's server is no longer paired",
      `Its path is on a server, not on this ${MACHINE}`,
    ];
  }
  const lines = [view.label, `Paired as ${view.target}`];
  const { link, reach } = view;
  switch (link.kind) {
    case "off":
      lines.push("Stream off — connects with your next message");
      break;
    case "unsupported":
      lines.push("Remote conversations are Claude-only — a Codex one can't run on this server");
      break;
    case "starting":
      lines.push("Session starting");
      break;
    case "connecting":
    case "reconnecting":
      lines.push(machineLinkView(view, nowMs, online)?.text ?? "Connecting…");
      break;
    case "attached":
      lines.push("Connected — the session's link is up");
      break;
    case "ended":
      lines.push("Session ended");
      break;
    case "failed":
      lines.push(`Link failed — ${link.message}`);
      lines.push(`Claude Code most likely still runs on the server: only this ${MACHINE}'s link gave up`);
      break;
  }
  if (!online) lines.push(`This ${MACHINE} is offline — nothing can be checked until the network is back`);
  if (reach.kind === "unknown") {
    lines.push(reach.probeError ? `Could not check it: ${reach.probeError}` : "Not checked yet");
  } else if (reach.kind === "reachable") {
    lines.push(`Reachable · checked ${checkedPhrase(reach.health, nowMs)}`);
    if (reach.health.probeError) lines.push(`Last check could not run: ${reach.health.probeError}`);
  } else {
    lines.push(`Unreachable · checked ${checkedPhrase(reach.health, nowMs)}`);
    if (reach.health.reason) lines.push(reach.health.reason);
    // Same sentence as the mark: WHEN tells "just fell over" from "was already gone".
    lines.push(lastReachedLine(lastReachedPhrase(reach.health, nowMs)));
    if (reach.health.probeError) lines.push(`Last check could not run: ${reach.health.probeError}`);
  }
  return lines;
}

/** Which actions the row offers. All of them are explicit gestures; none runs on its own.
 *  - `check`: a paired server only — an unpaired one has no address left to dial.
 *  - `reconnect`: only while the link is DOWN (connecting / reconnecting); an attached session
 *    ignores the nudge, and a session that is off has no link to retry.
 *  - `server`: the Settings server panel, for anything remote — pairing lives there too. */
export function machineActions(view: MachineView): { check: boolean; reconnect: boolean; server: boolean } {
  if (view.kind === "local") return { check: false, reconnect: false, server: false };
  if (view.kind === "unknown") return { check: false, reconnect: false, server: true };
  const down = view.link.kind === "connecting" || view.link.kind === "reconnecting";
  return { check: true, reconnect: down, server: true };
}

/** Whether anything the row shows is an AGE ("checked 2 min ago") that goes stale with the
 *  clock alone — the only case the row keeps a render clock running. */
export function machineShowsAge(view: MachineView): boolean {
  return view.kind === "remote" && view.reach.kind !== "unknown";
}

/** A key that changes whenever the link state does — a failed reconnect is shown only until the
 *  link moves on (a new attempt, attached, off), so it never outlives the situation it was about. */
export function machineLinkKey(link: MachineLink): string {
  if (link.kind === "reconnecting" || link.kind === "connecting") {
    return `${link.kind}:${link.attempt}:${link.retryAtMs}`;
  }
  return link.kind;
}
