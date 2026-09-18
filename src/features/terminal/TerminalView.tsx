import { useEffect, useRef } from "react";
import { attachTerm, ensureTerm } from "./termManager";
import styles from "./terminal.module.css";

// An interactive shell keeps its OWN working directory once started — it does not
// follow the agent's `EnterWorktree`/`ExitWorktree` moves (that would yank a real
// terminal out from under the user). So the live `cwd` only seeds the shell at
// creation; the attach effect must NOT re-run when it changes (doing so would tear
// down + re-attach the terminal — and steal focus — on every agent cwd move).

/**
 * The integrated terminal pane. Thin React shell: it owns a container element and,
 * on mount, attaches the conversation's long-lived xterm host into it (creating
 * the terminal + PTY on first use via `ensureTerm`). On unmount it only detaches —
 * the Terminal and its shell keep living, so closing the panel or switching
 * conversations never kills a running command. `stacked` flips the divider edge
 * (top vs left) to match the side region's placement, exactly like the editor.
 */
export default function TerminalView({
  convId,
  cwd,
  stacked,
  flush = false,
}: {
  /** The terminal's id — a conversation's stable id, or an IDE terminal's own id. */
  convId: string;
  cwd: string;
  stacked: boolean;
  /** No separator edge: the host (the IDE dock) already draws its own. */
  flush?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest cwd, read only when (lazily) creating the shell — never a re-attach trigger.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureTerm(convId, cwdRef.current);
    return attachTerm(convId, container);
  }, [convId]);

  return (
    <div
      className={
        styles.term + (stacked ? " " + styles.termStacked : "") + (flush ? " " + styles.termFlush : "")
      }
      ref={containerRef}
    />
  );
}
