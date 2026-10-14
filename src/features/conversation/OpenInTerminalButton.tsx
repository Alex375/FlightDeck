import { useState } from "react";
import { commands } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";
import { useAppErrors } from "../../store/appErrors";
import { useOpenInTerminalUnavailable } from "../../store/platformLimits";
import { openInTerminalUnavailable } from "../../store/remoteGates";
import { Ico } from "../../ui/kit";
import { useConvServer } from "./ConvMark";

/**
 * Title-bar action: resume the current conversation in an OS terminal, in its cwd —
 * `claude --resume <id>` for a Claude conversation, `codex resume <id>` for a Codex one
 * (the core picks the right CLI from `backend`; handing a Codex id to `claude` opens a
 * fresh empty session — the "wrong id" bug). Driven by the conversation's PERSISTED
 * session/thread id, so it works straight from the CLI's on-disk history with no live
 * process (disabled until an id exists). Opens a *separate*, user-driven CLI outside the app.
 *
 * Refused WITH the reason for a conversation on a paired server: the command runs in THIS
 * Mac's Terminal, where that session does not exist — at best a failed `cd`, at worst a brand
 * new local `claude` in a same-path clone of the repository, looking like the conversation.
 * Refused the same way on a platform where the core cannot open a terminal (Linux, for now).
 */
export function OpenInTerminalButton({
  convId,
  sessionId,
  cwd,
  backend,
}: {
  convId: string;
  sessionId: string | null;
  cwd: string;
  backend: BackendKind;
}) {
  const [busy, setBusy] = useState(false);
  const server = useConvServer(convId);
  const platformBlocked = useOpenInTerminalUnavailable();
  const blocked = server ? openInTerminalUnavailable(server) : platformBlocked;

  const open = async () => {
    if (blocked) {
      useAppErrors.getState().pushError("Can't open this conversation in the system terminal", blocked);
      return;
    }
    if (!sessionId || busy) return;
    setBusy(true);
    const res = await commands.openInTerminal(cwd, sessionId, backend);
    setBusy(false);
    if (res.status === "error") {
      // The core builds an actionable message; surface it instead of burying
      // it in the console where the user never sees why nothing opened.
      console.error("openInTerminal failed:", res.error);
      useAppErrors
        .getState()
        .pushError("Couldn't open the conversation in the system terminal.", res.error);
    }
  };

  return (
    <button
      type="button"
      className="wf-icon-btn"
      onClick={open}
      // ⚠️ A refusal (remote or platform) is NOT the `disabled` attribute (same as OpenInIdeButton): a disabled
      // control takes no pointer events, so its title never shows and the click can't say why.
      disabled={!blocked && (!sessionId || busy)}
      aria-disabled={blocked ? true : undefined}
      title={
        blocked ??
        (sessionId
          ? "Open the conversation in the system terminal"
          : "Available once the session has started")
      }
      aria-label="Open the conversation in the system terminal"
    >
      <Ico name="arrow" className="sm" />
    </button>
  );
}
