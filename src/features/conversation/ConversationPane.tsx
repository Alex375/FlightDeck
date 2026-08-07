import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { TodoBar } from "../todos/TodoBar";
import { ConductorComposer, type ComposerHandle } from "./ConductorComposer";
import { ConductorThread } from "./ConductorThread";
import { LastMessagePin } from "./LastMessagePin";
import { MessageMinimap } from "./MessageMinimap";
import { FileMentionProvider } from "./FileMention";
import { ReviewBar } from "./ReviewBar";
import { AuthWarningBar } from "./AuthWarningBar";
import { AgentBar } from "./AgentBar";
import { BashBar } from "./BashBar";
import { MonitorBar } from "./MonitorBar";
import { WorkflowBar } from "./WorkflowBar";
import { useStickToBottom } from "./useStickToBottom";
import { useEffectiveCleanOutput } from "../../store/display";

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
}) {
  // Toggling "clean output" folds/unfolds every round → big height change. Pass the
  // EFFECTIVE per-conversation value as the preserve key so the thread re-anchors instead
  // of jumping when the user flips it (via the chip or the global default).
  const cleanOutput = useEffectiveCleanOutput(session);
  const { scrollRef, onRender, scrollToBottom } = useStickToBottom(session, cleanOutput);
  // The pane is the positioning context (position:relative in CSS) AND the scope for the
  // pin's "scroll to my last message" lookup — see LastMessagePin.
  const paneRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={paneRef}
      className="wf-col cv-pane"
      style={{ flex: 1, minWidth: 0 }}
      onClick={onBackgroundClick}
    >
      {/* Floating "last message you sent" pin, pinned over the top of the thread. */}
      <LastMessagePin session={session} paneRef={paneRef} />
      {/* Floating column of bars over the thread's right edge — one per message sent.
          Mounted on EVERY surface that shows the thread (including the Flight Deck reply
          modal): one navigation affordance, everywhere. */}
      <MessageMinimap session={session} paneRef={paneRef} />
      {/* Provide the conversation id + live cwd so file mentions in the thread
          resolve + open in this conversation's editor. */}
      <FileMentionProvider convId={session} cwd={cwd} inert={inertMentions}>
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
      <TodoBar session={session} />
      <ReviewBar session={session} />
      <AuthWarningBar session={session} />
      <ConductorComposer ref={composerRef} session={session} onSent={scrollToBottom} />
    </div>
  );
}
