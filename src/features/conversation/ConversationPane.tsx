import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { TodoBar } from "../todos/TodoBar";
import { ConductorComposer, type ComposerHandle } from "./ConductorComposer";
import { ConductorThread } from "./ConductorThread";
import { LastMessagePin } from "./LastMessagePin";
import { ConversationMinimap } from "./MessageMinimap";
import { FileMentionProvider, type MentionOpener } from "./FileMention";
import { ReviewBar } from "./ReviewBar";
import { AuthWarningBar } from "./AuthWarningBar";
import { AgentBar } from "./AgentBar";
import { BashBar } from "./BashBar";
import { MonitorBar } from "./MonitorBar";
import { WorkflowBar } from "./WorkflowBar";
import { useStickToBottom } from "./useStickToBottom";
import { useThreadJumpTarget } from "./useThreadJumpTarget";
import { useDisplay, useEffectiveCleanOutput } from "../../store/display";
import { dropZoneAttrs, useIsDropOver } from "./fileDrop";
import { useConvPanelShown } from "../editor/editorStore";
import { ConversationSummaryLine } from "./ConversationSummaryLine";

/**
 * The active conversation's column: thread + bars + composer, sharing one
 * stick-to-bottom instance. The thread is the scroll container; the composer snaps
 * it to the bottom on send (`onSent`). Mounted with a per-conversation key so it
 * remounts on switch; the scroll position is remembered per conversation inside
 * the hook (keyed by `session`, the stable id), so reopening returns where the
 * user left off — defaulting to the bottom when there is no memory yet.
 *
 * Extracted from ConductorConversation so it can be reused both in the normal
 * MainArea (full width) and in the Git workspace (a narrow left column).
 */
export function ConversationPane({
  session,
  cwd,
  composerRef,
  onBackgroundClick,
  inertMentions = false,
  disableMessageControls = false,
  onOpenMention,
  hasPanels,
  panelHost = false,
}: {
  session: string;
  cwd: string;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** Render file mentions as plain text (no editor reveal). Set by the Flight Deck
   *  reply modal, which mounts the pane WITHOUT an editor host, so a mention click
   *  would be a dead link that silently flips the persisted editorOpen flag. */
  inertMentions?: boolean;
  /** Hide the per-message rewind/fork hover controls. Set by the Flight Deck reply
   *  modal: a destructive rewind or a background conversation-switching fork is never
   *  intended from that lightweight surface (and fork's switch is invisible there). */
  disableMessageControls?: boolean;
  /** Open clicked file mentions in the HOST's editor instead of the conversation view's
   *  side region. Set by the IDE view, whose editor is the workspace's, not this
   *  conversation's. */
  onOpenMention?: MentionOpener;
  /** Whether the host has the conversation view's side panels (editor / terminal / Git)
   *  for the composer's buttons to toggle. Defaults to "yes unless mentions are inert"
   *  (the reply modal); the IDE view passes false — its panels are its own. */
  hasPanels?: boolean;
  /** The host mounts the conversation side panel next to this pane (the conversation view,
   *  Git mode included). While the display pref keeps the panel on, the todo list and the
   *  composer's goal/artifact chips live THERE, and a one-line summary stands in for them
   *  here while the panel is closed. Hosts without the panel (the Flight Deck reply modal,
   *  the IDE view) keep them inline. */
  panelHost?: boolean;
}) {
  // Toggling "clean output" folds/unfolds every round → big height change. Pass the
  // EFFECTIVE per-conversation value as the preserve key so the thread re-anchors instead
  // of jumping when the user flips it (via the chip or the global default).
  const cleanOutput = useEffectiveCleanOutput(session);
  const { scrollRef, scrollEl, onRender, scrollToBottom, release } = useStickToBottom(session, cleanOutput);
  // Scroll to a message another conversation's card (or a toast) asked to be shown here.
  useThreadJumpTarget(session, scrollEl, release);
  // The pane is the positioning context (position:relative in CSS) AND the scope for the
  // pin's "scroll to my last message" lookup — see LastMessagePin.
  const paneRef = useRef<HTMLDivElement>(null);
  // The whole column is a drop zone for files dragged from the Finder (see fileDrop.ts):
  // they attach to THIS conversation exactly as the composer's "+" would.
  const dropOver = useIsDropOver(session, "pane");
  const sidePanelPref = useDisplay((s) => s.conversationSidePanel);
  // "Shown", not "open": a panel that stepped aside for lack of room is off screen, and the
  // summary line must stand in for it exactly as for a closed one.
  const panelOpen = useConvPanelShown();
  const inPanel = panelHost && sidePanelPref;
  return (
    <div
      ref={paneRef}
      className="wf-col cv-pane"
      style={{ flex: 1, minWidth: 0 }}
      onClick={onBackgroundClick}
      {...dropZoneAttrs(session, "pane")}
      data-drop-over={dropOver || undefined}
    >
      {/* Floating "last message you sent" pin, pinned over the top of the thread. */}
      <LastMessagePin session={session} paneRef={paneRef} />
      {/* Floating column of marks over the thread's right edge — one per message sent.
          Mounted on EVERY surface that shows the thread (including the Flight Deck reply
          modal): one navigation affordance, everywhere. The pane is the positioned host;
          the thread is the scroll container the column measures and watches. */}
      <ConversationMinimap session={session} hostRef={paneRef} scrollRef={scrollEl} />
      {/* Provide the conversation id + live cwd so file mentions in the thread
          resolve + open in this conversation's editor. */}
      <FileMentionProvider
        convId={session}
        cwd={cwd}
        inert={inertMentions}
        onOpen={onOpenMention ?? null}
      >
        <ConductorThread
          session={session}
          scrollRef={scrollRef}
          onRender={onRender}
          disableControls={disableMessageControls}
        />
      </FileMentionProvider>
      <AgentBar session={session} />
      <WorkflowBar session={session} />
      <BashBar session={session} />
      <MonitorBar session={session} />
      {!inPanel ? (
        <TodoBar session={session} />
      ) : !panelOpen ? (
        <ConversationSummaryLine session={session} />
      ) : null}
      <ReviewBar session={session} />
      <AuthWarningBar session={session} />
      <ConductorComposer
          ref={composerRef}
          session={session}
          onSent={scrollToBottom}
          hasPanels={hasPanels ?? !inertMentions}
          stateInPanel={inPanel}
        />
    </div>
  );
}
