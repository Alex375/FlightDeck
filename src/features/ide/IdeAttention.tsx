// "One of these agents wants you" — the pips shown on a folder's tab and on the dock's
// Conversations switch, so an agent waiting in a workspace (or a dock mode) that is NOT on
// screen is never waiting silently.
//
// One tiny subscriber per conversation: the status model is a hook (`useAgentStatus`), and
// a hook cannot run in a loop inside the parent. Each pip renders nothing while its agent
// is calm, so a quiet fleet costs a handful of empty components.
import { rowAttention } from "../../agent/status";
import { useAgentStatus } from "../../agent/useAgentStatus";
import styles from "./ide.module.css";

export function AttentionPips({ convIds }: { convIds: string[] }) {
  if (convIds.length === 0) return null;
  return (
    <span className={styles.pips}>
      {convIds.map((id) => (
        <AttentionPip key={id} convId={id} />
      ))}
    </span>
  );
}

function AttentionPip({ convId }: { convId: string }) {
  const attn = rowAttention(useAgentStatus(convId));
  if (!attn) return null;
  // Same three tints as the sidebar row: input (amber), review (blue), error (red).
  return <i className={styles.pip} data-attn={attn} />;
}
