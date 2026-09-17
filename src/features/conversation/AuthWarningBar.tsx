// Pre-emptive "this conversation's backend can't run" banner, pinned above the composer
// (same visual family as ReviewBar). Two failure modes, CONTEXTUAL to the conversation's
// OWN backend so a user of only one backend is never nagged about the other:
//   1. The CLI binary is not installed (`claude` / `codex` not on PATH / well-known dirs).
//   2. The binary is present but the account is logged out.
// (1) takes precedence: with no binary you can't be "logged out vs in", and the auth
// probe — which itself needs the binary — can't even run (it silently shows nothing).
// Both warn ONLY on a DEFINITIVE negative (a resolved `false`, a `loggedIn:false`) — never
// while still checking — so a transient glitch never cries wolf. Without this bar, the
// first hint of either problem would be the NEXT message failing; this tells the user
// before they type, with a direct jump to Settings → Accounts.
import { useConversationsStore, type BackendKind } from "../../store/conversationsStore";
import {
  useClaudeAvailable,
  useCodexAvailable,
  useBackendAvailabilityState,
} from "../../store/binaryAvailable";
import { useAccountsLoggedOut } from "../../ipc/useAccounts";
import { useSettingsUi } from "../../store/settingsUi";

export function AuthWarningBar({ session }: { session: string }) {
  const kind = useConversationsStore(
    (s) => (s.conversations.find((c) => c.id === session)?.kind ?? "claude") as BackendKind,
  );
  const claudeAvailable = useClaudeAvailable();
  const codexAvailable = useCodexAvailable();
  // The conversation's OWN backend availability, tri-state so we warn only on a resolved
  // `false` (never a flash before the check lands).
  const available = useBackendAvailabilityState(kind);
  const loggedOut = useAccountsLoggedOut(claudeAvailable, codexAvailable);
  const openSettings = useSettingsUi((s) => s.openSettings);

  const name = kind === "codex" ? "Codex" : "Claude";

  // Tone "error" (red) for both: each is a hard blocker — the next send WILL fail — not a
  // soft warning. The button jumps to Settings → Accounts, where the missing-binary install
  // hint (and the login flow) live.
  if (available === false) {
    return (
      <div className="cv-reviewbar" data-tone="error">
        <span className="cv-reviewbar-dot" />
        <span className="cv-reviewbar-label">
          {name} CLI not found — the next messages will fail.
        </span>
        <button className="cv-reviewbar-btn" onClick={() => openSettings("general", "accounts")}>
          Settings
        </button>
      </div>
    );
  }

  const disconnected = kind === "codex" ? loggedOut.codex : loggedOut.claude;
  if (!disconnected) return null;

  return (
    <div className="cv-reviewbar" data-tone="error">
      <span className="cv-reviewbar-dot" />
      <span className="cv-reviewbar-label">
        {name} account not connected — the next messages will fail.
      </span>
      <button className="cv-reviewbar-btn" onClick={() => openSettings("general", "accounts")}>
        Sign in
      </button>
    </div>
  );
}
