// User preferences for how the conversation transcript is displayed. Pure UI prefs,
// persisted to localStorage (same lightweight pattern as notifications.ts) rather
// than the Rust core — they are not domain data, so they don't belong in the SQLite
// metadata store.
import { create } from "zustand";
import { useConversationsStore } from "./conversationsStore";
import { DEFAULT_ZOOM, sanitizeZoom } from "../ui/zoom";

const STORAGE_KEY = "tosse:display";

/** How Markdown is rendered everywhere it appears (conversation thread, sub-agent
 *  transcripts, and the `.md` file preview — all go through {@link StreamMarkdown}).
 *  - `classic`: the historical GitHub-flavoured look (boxed, full-grid tables).
 *  - `warm`   : soft/on-brand — coral accents, card code blocks, salient filenames.
 *  - `minimal`: neutral/typographic — airy, hairline chrome, uppercase section heads.
 *  A single GLOBAL setting (not per-conversation): one look across the whole app. */
export type MarkdownMode = "classic" | "warm" | "minimal";

/** What the message minimap shows when a bar is hovered.
 *  - `summary`: one line — the summary saved for that message when it was sent, or a
 *    truncation for the messages that were never summarized (short ones and slash
 *    commands, where the truncation already IS the message).
 *  - `full`   : the message as sent, in a scrollable preview.
 *  See {@link MessageMinimap}. */
export type MinimapHoverMode = "summary" | "full";

export interface DisplayPrefs {
  /** The GLOBAL DEFAULT for "clean output" — folding an assistant response's intermediate
   *  work (tool runs, thinking, in-between narration, sub-agents) into ONE collapsible
   *  "Claude's work — N steps" block, so only the response's CONCLUDING message stays
   *  in clear. Per response, not per app: each response keeps its own block + concluding
   *  message. When a response spans several turns, only its LAST message stays in clear.
   *  See ConductorThread/CleanBlocks.
   *
   *  This is the DEFAULT applied to any conversation that has not set its OWN preference:
   *  clean output is a per-conversation setting (persisted in SQLite as `Conversation.cleanOutput`,
   *  a tristate where null = "inherit this default"). The Settings → General toggle writes THIS
   *  default; the composer chip writes the current conversation's explicit override. The
   *  effective value for a conversation is resolved by {@link useEffectiveCleanOutput}. */
  cleanOutput: boolean;

  /** The Markdown rendering look, applied globally to every surface that renders
   *  Markdown. See {@link MarkdownMode}. Set from Settings → Conversation. */
  markdownMode: MarkdownMode;

  /** How much the WHOLE interface is scaled — conversation, Flight Deck, editor, terminal,
   *  popovers, everything — as a factor on the {@link ZOOM_STEPS} ladder (1 = 100 %, the
   *  default). Set from Settings → General → Display, or from anywhere with ⌘+ / ⌘− / ⌘0.
   *
   *  Applied by the OS webview rather than by CSS (see `ui/zoom.ts` for why), so this value
   *  is pushed to the Rust side by {@link ZoomHost} — nothing reads it to render with. It is
   *  {@link sanitizeZoom}d on load AND on write: a corrupted entry that reached the webview
   *  could leave the window unreadable with no way back through the UI. */
  uiZoom: number;

  /** Show the "Fleet readout" banner (the adaptive "N Running · N Review · …" stage
   *  counts across the whole fleet) at the TOP of the FlightDeck. On by default. Set
   *  from Settings → General. Independent of {@link fleetBannerConversation}. */
  fleetBannerFlightDeck: boolean;

  /** Show the compact "Fleet readout" box at the BOTTOM of the conversation sidebar.
   *  On by default. Set from Settings → General. Independent of
   *  {@link fleetBannerFlightDeck}. */
  fleetBannerConversation: boolean;

  /** Show the CLI-injected `<task-notification>` messages (a background task/agent
   *  finished) in the conversation thread. OFF by default — they're machine-injected
   *  noise that clutters the transcript, especially on reload / history import. The
   *  clean render (SpecialMessageCard) is kept, just gated: flip this on to see them
   *  again. Read by {@link SpecialMessageCard}. */
  showTaskNotifications: boolean;

  /** Show the floating "last message you sent" pin at the TOP of the conversation view
   *  — the same preview shown on the Flight Deck (the message verbatim when short, else
   *  its ≤6-word Haiku summary). Clicking it scrolls the thread to that message. On by
   *  default. Read by {@link LastMessagePin}. */
  showLastMessagePreview: boolean;

  /** Make the composer's stop button first try to UN-SEND the message you just sent —
   *  dropping it from the binary's queue and putting its text back in the composer —
   *  instead of only interrupting the turn. Falls back to a plain interrupt whenever the
   *  turn has already started, so nothing is ever lost. ON by default. Turn it off to get
   *  the plain interrupt back. Read by {@link useStopOrUnsend}. */
  cancelRestoreOnStop: boolean;

  /** Show the message minimap: a column of small bars floating over the RIGHT edge of the
   *  conversation, one per message you sent — hover previews it, click scrolls to it. ON by
   *  default. Read by {@link MessageMinimap}. */
  messageMinimap: boolean;

  /** What a minimap bar shows on hover — a one-line summary or the whole message.
   *  See {@link MinimapHoverMode}. Only has an effect while {@link messageMinimap} is on. */
  minimapHoverMode: MinimapHoverMode;

  /** Show a RUNNING workflow's live readout on its Flight Deck card — the current phase, how
   *  many of its agents are in the air, and how far along the run is, read from the run's
   *  on-disk journal. ON by default. Off → the card falls back to what it showed before: the
   *  generic "⚙ N background tasks" chip, which counts tasks, not a workflow's inner agents.
   *  Only ever visible while a workflow runs. Read by {@link WorkflowPeek}. */
  workflowLiveCard: boolean;

  /** Show the hover controls on conversation messages — "resume from here" (rewind
   *  the conversation in place) and "fork" (branch a new conversation at this message),
   *  offered on both the user's and Claude's messages. ON by default. Off → messages have no
   *  hover controls. Read by {@link MessageActions} (via the conversation thread). */
  messageControls: boolean;

  /** Make the filename on a tool STEP ROW (the "Edit foo.ts" row that also expands the card)
   *  clickable. ON by default. Off → that row is a plain expander and its filename is plain
   *  text. DELIBERATELY NARROW: it gates that one dual-purpose surface and NOTHING else —
   *  paths in prose, Markdown file links and the filename in the expanded diff/snippet header
   *  stay clickable everywhere (conversation, Flight Deck…) whatever this pref says. Read by
   *  {@link FileMentionProvider} (surfaced as its `stepRowInert`). */
  clickableFileMentions: boolean;

  /** Show the TOSSE mark on a repository's sidebar header — solid when the folder is
   *  associated with a CRM repository, hollow-on-hover when it is not (an invitation to
   *  associate it by hand). Clicking it opens that repository's TOSSE card. ON by default.
   *  Off → the header looks exactly as it did before the feature, and the association is
   *  not even computed (no repository list fetched, no git remote read). Nothing shows in
   *  either case when TOSSE is not connected. Read by {@link TosseRepoBadge}. */
  tosseRepoBadge: boolean;

  /** Warn before deleting a conversation that is linked to a TOSSE task in « En cours »
   *  or « Review ». ON by default — the delete is otherwise friction-free (one click,
   *  ⌘Z to undo), and dropping the conversation someone's live task is being worked in
   *  deserves a question. Off → linked conversations delete like any other (a RUNNING
   *  conversation still asks: that guard is about killing a live session, not about
   *  TOSSE). Read by {@link deleteReason}; the status compared is the one stored ON the
   *  conversation, so the warning still works offline. */
  tosseTaskDeleteWarning: boolean;

  /** Show the TOSSE tasks view — the third top-level view (⌘3), listing the CRM's projects
   *  by client. ON by default. Off → the tab disappears and the view is never mounted, so
   *  the briefing is not fetched either. Note this preference only ever MATTERS while
   *  signed in to TOSSE: signed out, the tab is absent regardless (an empty shell would be
   *  worse than no tab, per the feature's spec). Read by {@link App}. */
  tosseTasksView: boolean;

  /** Keep the window on the TASKS view after pressing « Start » on a task — the conversation
   *  opens and its first message goes out, but the app does not follow it. ON by default:
   *  starting is a HAND-OFF (the agent picks the task up on its own), so being thrown into a
   *  thread that has nothing to show yet only costs the place in the list one was reading.
   *  Off → the window switches to the new conversation, as it did before.
   *
   *  Deliberately « Start » only. « Discuss » always hands over whatever this says: that
   *  button exists to ASK something, and the answer is the point of pressing it.
   *
   *  Nothing is lost either way — the task row gains its « Open » button as soon as the
   *  conversation is linked. Read via {@link launchFocusesConversation}. */
  tosseStartStaysOnTasks: boolean;

  /** Fetch a client's mark from Google's favicon service when the CRM holds no uploaded
   *  logo for it.
   *
   *  ⚠️ **ON by default since 2026-08-07, reversing the default it shipped with.** What it
   *  sends has not changed and is still the reason this is a SWITCH at all: every such
   *  client's DOMAIN — i.e. a slice of Tosse's client list — plus this machine's IP go to
   *  `google.com/s2/favicons`, one request per client shown.
   *
   *  It is not the app's only call to that service ({@link webResultFaviconUrl} resolves
   *  one per web-search result chip, and always has). What is different here is the DATA:
   *  a search result is a public site the model just visited, whereas these domains are
   *  who Tosse works for. The CRM's own web page resolves them the same way, so the app is
   *  matching a call the browser already makes for the same person looking at the same
   *  list — which is what settled the default: shipped off, the marks looked broken (they
   *  read as "the logos don't work"), and the privacy question stays answerable by one
   *  visible toggle in Settings → TOSSE.
   *
   *  Off → the cascade stops at the CRM's uploaded logo, then the client's initials on a
   *  colour derived from its name (no network at all).
   *  Read by {@link ClientAvatar}. */
  tosseClientFavicons: boolean;

  /** Show the TURN's own timing in the conversation thread. Gates two surfaces: the total
   *  wall-clock in the FINISHED-turn footer (`result.duration_ms`) — {@link TurnResultRow};
   *  AND the LIVE elapsed counter on a running turn past the threshold — {@link LiveElapsed}.
   *  ON by default. Off → neither is rendered. */
  showTurnDuration: boolean;

  /** Show the "· N s of model" breakdown (`result.duration_api_ms`) next to the turn's
   *  total in the footer. Rides the footer, so only visible when {@link showTurnDuration} is
   *  also on. ON by default. Read by {@link TurnResultRow}. */
  showModelTime: boolean;

  /** Show the reflection time on each thinking block — a live counter while thinking, frozen
   *  once settled. ON by default. Off → thinking blocks render without a duration. */
  showThinkingTime: boolean;

  /** Show the per-tool duration on each tool row — a live counter while the tool runs, frozen
   *  once its result lands. ON by default. Off → tool rows render without a duration. Read by
   *  {@link LiveToolStep}. */
  showToolTime: boolean;

  /** Re-alert at a clean turn end when the ONLY background work still running is a background
   *  Bash command. OFF by default (the calm green `backgrounding` state — no ping — applies to
   *  every background tool, the shipped behaviour). ON adds a ONE-TIME alert FOR BASH COMMANDS
   *  ONLY: a turn that finishes while a background Bash command is the sole remaining background
   *  task fires the "done" notification and surfaces the blue "to review" (`review`) state instead
   *  of silently going green. It is a one-shot "go look": as soon as the user marks the turn seen,
   *  the conversation falls back to today's green `backgrounding` while the Bash keeps running.
   *  Scope is strict: the moment any non-Bash background work (sub-agent / workflow / Monitor) is
   *  also running, the finish stays green (the agent resumes on its own). Read by the status
   *  derivation ({@link deriveAgentStatus} via {@link AgentSignals.reAlertOnBackgroundBash}) and
   *  the notification suppression. */
  alertOnBackgroundBash: boolean;

  /** Auto-reorder the conversation SIDEBAR's conversations by recency (most-recent first,
   *  the historical behaviour). ON by default. OFF → the sidebar keeps a MANUAL, drag-and-drop
   *  order that never reshuffles on its own (new conversations still land on top). Read by
   *  {@link useConversationsByRepo}. Independent of the repo-level toggle below. */
  autoOrderSidebarConvs: boolean;

  /** Auto-reorder the conversation SIDEBAR's repositories by recency. ON by default. OFF →
   *  the repo groups keep a MANUAL, drag-and-drop order. Read by {@link useConversationsByRepo}. */
  autoOrderSidebarRepos: boolean;

  /** Auto-reorder the FLIGHT DECK's cards by status-then-recency (the historical behaviour —
   *  action-required/error → review → running → idle → off). ON by default. OFF → the cards in
   *  each swimlane keep a MANUAL, drag-and-drop order that never reshuffles, so even a card that
   *  needs attention stays put (new conversations still land at the very start). Read by
   *  {@link useFleetLanes}. */
  autoOrderFleetConvs: boolean;

  /** Auto-reorder the FLIGHT DECK's swimlanes (repositories) by status-then-recency. ON by
   *  default. OFF → the swimlanes keep a MANUAL, drag-and-drop order. Read by {@link useFleetLanes}. */
  autoOrderFleetRepos: boolean;

  /** Whether the sidebar and the Flight Deck SHARE one manual order (drag in one reorders both)
   *  or keep independent arrangements. ON by default (one canonical order). Only affects levels
   *  that are in manual mode. Read via {@link slotFor}. */
  sharedManualOrder: boolean;
}

// Off by default: the transcript shows everything inline as before. The user opts in
// (Settings → General, or the composer chip) when they want the condensed reading view.
// markdownMode defaults to `warm` — the on-brand, cleaner look (the whole point of the
// feature); users can switch to `minimal` or back to `classic` in Settings → Conversation.
const DEFAULTS: DisplayPrefs = {
  cleanOutput: false,
  markdownMode: "warm",
  uiZoom: DEFAULT_ZOOM,
  fleetBannerFlightDeck: true,
  fleetBannerConversation: true,
  showTaskNotifications: false,
  showLastMessagePreview: true,
  // On by default: this is what the CLI itself does on stop, and it can only ever do
  // MORE than the old behaviour (it degrades to the same interrupt when the turn has
  // already started).
  cancelRestoreOnStop: true,
  // The minimap is quiet at rest (it only comes forward on hover) and hides itself below
  // two messages, so it costs nothing on the short conversations where it has nothing to
  // map. Summary hover by default: one line reads at a glance; "full" is a click away in
  // Settings for whoever prefers the message verbatim.
  messageMinimap: true,
  minimapHoverMode: "summary",
  workflowLiveCard: true,
  messageControls: true,
  clickableFileMentions: true,
  tosseRepoBadge: true,
  tosseTasksView: true,
  tosseStartStaysOnTasks: true,
  tosseTaskDeleteWarning: true,
  // ON, though it is the only preference here that sends CRM data to a third party: the
  // CRM's own page makes the same call for the same person, and off, the marks read as
  // broken rather than as a choice. Switchable in Settings → TOSSE (see its doc).
  tosseClientFavicons: true,
  showTurnDuration: true,
  showModelTime: true,
  showThinkingTime: true,
  showToolTime: true,
  alertOnBackgroundBash: false,
  // Ordering defaults to today's automatic behaviour (recency / status-first); the user
  // opts into a frozen, drag-ordered layout per surface+level. Shared order on by default.
  autoOrderSidebarConvs: true,
  autoOrderSidebarRepos: true,
  autoOrderFleetConvs: true,
  autoOrderFleetRepos: true,
  sharedManualOrder: true,
};

function load(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for users who already
    // have a stored (older, smaller) prefs object. The zoom is the one pref a bad stored
    // value could make the app unusable with (see `sanitizeZoom`), so it is re-checked
    // here rather than trusted from storage.
    const stored = JSON.parse(raw) as Partial<DisplayPrefs>;
    return { ...DEFAULTS, ...stored, uiZoom: sanitizeZoom(stored.uiZoom ?? DEFAULT_ZOOM) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: DisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface DisplayState extends DisplayPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<DisplayPrefs>) => void;
}

export const useDisplay = create<DisplayState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: DisplayPrefs = {
        cleanOutput: patch.cleanOutput ?? s.cleanOutput,
        markdownMode: patch.markdownMode ?? s.markdownMode,
        uiZoom: sanitizeZoom(patch.uiZoom ?? s.uiZoom),
        fleetBannerFlightDeck: patch.fleetBannerFlightDeck ?? s.fleetBannerFlightDeck,
        fleetBannerConversation: patch.fleetBannerConversation ?? s.fleetBannerConversation,
        showTaskNotifications: patch.showTaskNotifications ?? s.showTaskNotifications,
        showLastMessagePreview: patch.showLastMessagePreview ?? s.showLastMessagePreview,
        cancelRestoreOnStop: patch.cancelRestoreOnStop ?? s.cancelRestoreOnStop,
        messageMinimap: patch.messageMinimap ?? s.messageMinimap,
        minimapHoverMode: patch.minimapHoverMode ?? s.minimapHoverMode,
        workflowLiveCard: patch.workflowLiveCard ?? s.workflowLiveCard,
        messageControls: patch.messageControls ?? s.messageControls,
        clickableFileMentions: patch.clickableFileMentions ?? s.clickableFileMentions,
        tosseRepoBadge: patch.tosseRepoBadge ?? s.tosseRepoBadge,
        tosseTasksView: patch.tosseTasksView ?? s.tosseTasksView,
        tosseStartStaysOnTasks: patch.tosseStartStaysOnTasks ?? s.tosseStartStaysOnTasks,
        tosseTaskDeleteWarning: patch.tosseTaskDeleteWarning ?? s.tosseTaskDeleteWarning,
        tosseClientFavicons: patch.tosseClientFavicons ?? s.tosseClientFavicons,
        showTurnDuration: patch.showTurnDuration ?? s.showTurnDuration,
        showModelTime: patch.showModelTime ?? s.showModelTime,
        showThinkingTime: patch.showThinkingTime ?? s.showThinkingTime,
        showToolTime: patch.showToolTime ?? s.showToolTime,
        alertOnBackgroundBash: patch.alertOnBackgroundBash ?? s.alertOnBackgroundBash,
        autoOrderSidebarConvs: patch.autoOrderSidebarConvs ?? s.autoOrderSidebarConvs,
        autoOrderSidebarRepos: patch.autoOrderSidebarRepos ?? s.autoOrderSidebarRepos,
        autoOrderFleetConvs: patch.autoOrderFleetConvs ?? s.autoOrderFleetConvs,
        autoOrderFleetRepos: patch.autoOrderFleetRepos ?? s.autoOrderFleetRepos,
        sharedManualOrder: patch.sharedManualOrder ?? s.sharedManualOrder,
      };
      save(next);
      return next;
    }),
}));

/** The global Markdown rendering mode. Read by {@link StreamMarkdown} (which stamps it
 *  as `data-md-mode` on its root and provides it via context to CodeBlock). */
export function useMarkdownMode(): MarkdownMode {
  return useDisplay((s) => s.markdownMode);
}

/**
 * Collapse the per-conversation clean-output tristate onto a concrete boolean: an
 * explicit override (`true`/`false`) wins; `null` inherits the global default. Pure
 * so the semantics are locked in a test — crucially, an explicit `false` override
 * MUST beat a `true` global default (that is the whole point of per-conversation:
 * one conversation can opt OUT even when the default is on).
 */
export function resolveCleanOutput(override: boolean | null, globalDefault: boolean): boolean {
  return override ?? globalDefault;
}

/**
 * The EFFECTIVE "clean output" for a conversation: its own explicit choice when it
 * has one, else the global default. This is the single resolver every renderer reads
 * — the thread ({@link AssistantBlocks}), the composer chip, and the scroll-preserve
 * key ({@link ConversationPane}) — so a per-conversation override and the global
 * default never disagree.
 *
 * `Conversation.cleanOutput` is a tristate: `true`/`false` is an explicit override,
 * `null` means "inherit the global default" (the state every conversation starts in,
 * and the state pre-existing rows migrate to — so behaviour is unchanged until the
 * user flips the chip on a specific conversation).
 */
export function useEffectiveCleanOutput(convId: string): boolean {
  const globalDefault = useDisplay((s) => s.cleanOutput);
  const override = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.cleanOutput ?? null,
  );
  return resolveCleanOutput(override, globalDefault);
}
