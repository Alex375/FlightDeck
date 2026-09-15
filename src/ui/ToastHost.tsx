// Renders the in-app toasts (store/toasts.ts), stacked in the window's top-right corner.
// Mounted once in App. Each toast leaves on its own after a few seconds, but not while the
// pointer rests on it — a toast you are about to click must not vanish under the cursor.

import { useEffect, useState } from "react";
import { useConversationsStore } from "../store/conversationsStore";
import { openConversationAt, type JumpAnchor } from "../store/threadJump";
import { useToasts, type AgentMessageToast, type Toast } from "../store/toasts";
import { Ico } from "./kit";
import styles from "./ToastHost.module.css";

const LIFETIME_MS = 7000;

/** A conversation name that jumps to its side of the exchange; plain text once the
 *  conversation is no longer on the list. */
function ConversationLink({
  id,
  fallback,
  anchor,
  onOpen,
}: {
  id: string;
  fallback: string;
  anchor: JumpAnchor;
  onOpen: () => void;
}) {
  const name = useConversationsStore((s) => s.conversations.find((c) => c.id === id)?.name ?? null);
  const label = name?.trim() || fallback;
  if (name === null) return <span className={styles.conv}>{label}</span>;
  return (
    <button
      type="button"
      className={`${styles.conv} ${styles.link}`}
      title="Open this conversation at the message"
      onClick={() => {
        openConversationAt(id, anchor);
        onOpen();
      }}
    >
      {label}
    </button>
  );
}

function AgentMessageBody({ toast, onOpen }: { toast: AgentMessageToast; onOpen: () => void }) {
  return (
    <>
      <span className={styles.ico}>
        <Ico name="send" className="sm" />
      </span>
      <div className={styles.main}>
        <div className={styles.head}>
          <ConversationLink
            id={toast.fromConvId}
            fallback={toast.fromTitle}
            anchor={{ kind: "sent", messageId: toast.messageId }}
            onOpen={onOpen}
          />
          <Ico name="arrow" className={`sm ${styles.arrow}`} />
          <ConversationLink
            id={toast.toConvId}
            fallback={toast.toTitle}
            anchor={{ kind: "received", messageId: toast.messageId }}
            onOpen={onOpen}
          />
        </div>
        {toast.excerpt ? <div className={styles.excerpt}>{toast.excerpt}</div> : null}
      </div>
    </>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timer = window.setTimeout(() => dismiss(toast.id), LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [hovered, toast.id, dismiss]);
  const close = () => dismiss(toast.id);
  return (
    <div
      className={styles.toast}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {toast.kind === "agent-message" ? (
        <AgentMessageBody toast={toast} onOpen={close} />
      ) : (
        <>
          <span className={styles.ico}>
            <Ico name="alert" className="sm" />
          </span>
          <div className={`${styles.main} ${styles.info}`}>{toast.text}</div>
        </>
      )}
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={close}>
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
