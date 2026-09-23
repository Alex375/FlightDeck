// Which band sits at the top of the composer card — AT MOST ONE, chosen here.
//
// ⚠️ `.cv-sband` is the card's HEADER: it pulls up into the card's padding and carries its
// top corners, and the card tints its own border and halo from it through
// `:has(> .cv-sband)`. Two stacked would give the composer two rounded tops, a doubled
// border and two competing tints. So this is a router, not a stack.
//
// Everything that used to float ABOVE the composer as a `.cv-reviewbar` card lives here
// now. That class was the pre-redesign design — the conversation's status moved INTO the
// composer card (3a3fba3, then 89225f2 "make the tinted rows and composer status band the
// only design"), and a warning that kept the old look read as a different KIND of thing
// rather than as this conversation's state.
//
// Order, most-blocking first. All three warnings are "your next message will fail", so
// what decides is which failure the user would hit FIRST — and each one makes the ones
// below it moot:
//   1. The backend CLI is missing        — nothing can start at all.
//   2. The backend account is signed out — it starts and refuses.
//   3. The server is out of reach        — it would start fine, somewhere we can't dial.
// The conversation's own settled status comes last: whatever it says is about a turn that
// already finished, while all three of these are about every turn from here on. "Continue"
// would fail on the spot and "Mark as seen" would tidy the colour away with the real
// problem left invisible.
import { useConversationsStore, useConversationRepo, useMachines, type BackendKind } from "../../store/conversationsStore";
import {
  useClaudeAvailable,
  useCodexAvailable,
  useBackendAvailabilityState,
} from "../../store/binaryAvailable";
import { useAccountsLoggedOut } from "../../ipc/useAccounts";
import { isUnreachable, useMachineHealth } from "../../store/machineHealth";
import { useSettingsUi } from "../../store/settingsUi";
import { Ico } from "../../ui/kit";
import { ComposerStatusBand } from "./ComposerStatusBand";

/** One band: the shared shape every warning here renders as, so they cannot drift apart.
 *  Same grammar as `ComposerStatusBand` — icon · label · detail · action. */
function WarningBand({
  icon,
  label,
  detail,
  action,
  actionIcon,
  onAction,
  actionTitle,
}: {
  icon: string;
  label: string;
  detail: string;
  action: string;
  actionIcon: string;
  onAction: () => void;
  actionTitle: string;
}) {
  return (
    <div className="cv-sband" data-tone="error" role="status">
      <Ico name={icon} className="cv-sband-ico" />
      <span className="cv-sband-label">{label}</span>
      <span className="cv-sband-sep">·</span>
      <span className="cv-sband-detail" title={detail}>
        {detail}
      </span>
      <span className="cv-sband-fill" />
      <button type="button" className="cv-sband-btn" onClick={onAction} title={actionTitle}>
        <Ico name={actionIcon} className="sm" />
        {action}
      </button>
    </div>
  );
}

/** The machine this conversation runs on, when we have CHECKED it and found it out of
 *  reach. `null` for a local conversation, and for a remote one we have no verdict on —
 *  the same "never on a guess" rule the remote mark itself follows. */
function useUnreachableServer(session: string): { name: string; reason: string | null } | null {
  const repo = useConversationRepo(session);
  const machineId = repo?.machineId ?? null;
  const machines = useMachines();
  const health = useMachineHealth(machineId);
  if (!machineId || !isUnreachable(health)) return null;
  return {
    name: machines.find((m) => m.id === machineId)?.label ?? "This server",
    reason: health?.reason ?? null,
  };
}

export function ComposerBand({ session }: { session: string }) {
  const kind = useConversationsStore(
    (s) => (s.conversations.find((c) => c.id === session)?.kind ?? "claude") as BackendKind,
  );
  const repo = useConversationRepo(session);
  // ⚠️ `binaryAvailable` and `useAccountsLoggedOut` both describe THIS MAC. A remote
  // conversation runs its `claude` on the server, against the SERVER's own credential
  // store — `spawn_session` refuses a local account for one outright ("Remote (SSH)
  // conversations run on the server's own Claude account"). So neither warning applies
  // there: raising them would nag about a binary and a sign-in that have nothing to do
  // with the agent being talked to, and point at a Settings page that cannot fix it. The
  // server's own equivalents are facts on its card in Settings → Control → Remote
  // ("Claude installed", "Claude signed in"), which the unreachable band below leads to.
  const isRemote = !!repo?.machineId;
  const claudeAvailable = useClaudeAvailable();
  const codexAvailable = useCodexAvailable();
  // Tri-state so we warn only on a resolved `false`, never on a flash before the check lands.
  const available = useBackendAvailabilityState(kind);
  const loggedOut = useAccountsLoggedOut(claudeAvailable, codexAvailable);
  const down = useUnreachableServer(session);
  const openSettings = useSettingsUi((s) => s.openSettings);

  const name = kind === "codex" ? "Codex" : "Claude";
  const toAccounts = () => openSettings("general", "accounts");

  if (!isRemote && available === false) {
    return (
      <WarningBand
        icon="alert"
        label={`${name} CLI not found`}
        detail="the next messages will fail"
        action="Settings"
        actionIcon="arrow"
        onAction={toAccounts}
        actionTitle="Open Settings → Accounts, where the install hint and the sign-in flow live"
      />
    );
  }

  if (!isRemote && (kind === "codex" ? loggedOut.codex : loggedOut.claude)) {
    return (
      <WarningBand
        icon="alert"
        label={`${name} account not connected`}
        detail="the next messages will fail"
        action="Sign in"
        actionIcon="arrow"
        onAction={toAccounts}
        actionTitle="Open Settings → Accounts to sign in"
      />
    );
  }

  if (down) {
    return (
      <WarningBand
        icon="serverOff"
        label={`${down.name} unreachable`}
        detail={
          down.reason
            ? `${down.reason} — messages to this agent will fail`
            : "messages to this agent will fail"
        }
        action="Diagnose"
        actionIcon="pulse"
        onAction={() => openSettings("control", "remote")}
        actionTitle="Open this server's panel in Settings — diagnosis and repairs"
      />
    );
  }

  return <ComposerStatusBand session={session} />;
}
