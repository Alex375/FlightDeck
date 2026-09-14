// The composer's Claude ACCOUNT chip: which subscription this conversation's turns are
// billed against, and a menu to move it to another one.
//
// Deliberately its own control rather than a section inside the model picker: the model is
// what answers, the account is who pays for it. Folding them together would make one look
// like a variant of the other.
//
// It renders when there IS a choice (two or more accounts signed in) — and ALSO whenever the
// conversation points at an account that no longer exists, since this chip is the only UI
// that can re-point it. Otherwise a single-account setup sees no change at all. Claude only;
// the composer bar's backend filter keeps it off Codex conversations.
import { Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useConversationsStore } from "../../store/conversationsStore";
import { useClaudeAccounts } from "../../ipc/useAccounts";
import { usePlanUsage } from "../../store/planUsage";
import { peakUsagePercent } from "../../store/claudeAccounts";
import { AccountFace } from "./composerChipFaces";

/** The label shown for the default (un-scoped) account — the one that always exists. */
const DEFAULT_LABEL = "Claude";

export function AccountChip({ session }: { session: string }) {
  const accounts = useClaudeAccounts(true);
  const conv = useConversationsStore((s) => s.conversations.find((c) => c.id === session));
  // A conversation in a REMOTE repo runs on the server's own Claude account: the account
  // is a local environment variable the SSH launcher does not carry, and the core refuses
  // one there. Offering the picker would promise something that cannot be honoured.
  const remote = useConversationsStore(
    (s) => !!s.repos.find((r) => r.id === conv?.repoId)?.machineId,
  );
  const rows = accounts.data ?? [];
  const currentId = conv?.claudeAccountId ?? null;
  const live = !!conv?.handle;

  // Computed BEFORE any early return: an orphaned pointer must keep its repair surface
  // even when the last extra account is gone.
  const orphaned = !!accounts.data && currentId !== null && !rows.some((a) => a.id === currentId);
  if (rows.length === 0 && !orphaned) return null;
  // A remote conversation already on the default account has nothing to choose.
  if (remote && !orphaned && currentId === null) return null;

  const nameOf = (id: string | null) =>
    id === null
      ? DEFAULT_LABEL
      : (rows.find((a) => a.id === id)?.label ??
        // The conversation names an account that is gone. Say so rather than silently
        // showing the default: the session will refuse to start until it is re-pointed.
        "Unknown account");

  // A running process cannot change identity, so the chip shows what the SESSION is
  // actually authenticated as until the restart lands — claiming the new account while the
  // old one is still being billed is the one thing this control must never do.
  const liveId = conv?.liveClaudeAccountId ?? null;
  const pendingSwitch = live && liveId !== currentId;
  const label = pendingSwitch ? nameOf(liveId) : nameOf(currentId);

  const pick = (id: string | null) => {
    useConversationsStore.getState().setConvClaudeAccount(session, id);
  };

  return (
    <Menu
      up
      trigger={
        <AccountFace
          label={label}
          pending={orphaned || pendingSwitch}
          title={
            orphaned
              ? "This conversation is tied to a Claude account that no longer exists — pick another one"
              : pendingSwitch
                ? `Still running on ${nameOf(liveId)} — switching to ${nameOf(currentId)} when the current turn ends`
                : "Claude account — which subscription this conversation's turns count against"
          }
        />
      }
    >
      <MenuLabel>Claude account</MenuLabel>
      <AccountOption
        accountId={null}
        label={DEFAULT_LABEL}
        on={currentId === null}
        onPick={() => pick(null)}
      />
      {/* Remote conversations can only use the server's account, so the extra accounts are
          not offered there — only the way back to the default. */}
      {remote
        ? null
        : rows.map((a) => (
            <AccountOption
              key={a.id}
              accountId={a.id}
              label={a.label}
              on={currentId === a.id}
              onPick={() => pick(a.id)}
            />
          ))}
      {remote ? (
        <MenuItem disabled>Remote conversations use the server's Claude account</MenuItem>
      ) : null}
      {/* A running process cannot change identity — the CLI reads its credentials once at
          startup — so a pick restarts the session, and only once the current turn (and any
          background task) has finished. Say when it takes effect instead of implying it
          already has. */}
      {pendingSwitch ? (
        <MenuItem disabled>{`Applies when the current turn ends — still on ${nameOf(liveId)}`}</MenuItem>
      ) : live ? (
        <MenuItem disabled>Switching restarts this session (the transcript is kept)</MenuItem>
      ) : null}
      {orphaned ? <MenuItem disabled>The current account was removed</MenuItem> : null}
    </Menu>
  );
}

/** One account row, with its current fill so the choice is informed rather than blind —
 *  the same number the ring and Settings → Accounts show, from the same query cache (so
 *  opening this menu costs nothing extra when the panel was already open).
 *
 *  `enabled: false` keeps it to what is ALREADY cached: merely opening the menu must not
 *  read every account's credentials (and, on macOS, pop a Keychain prompt per account). */
function AccountOption({
  accountId,
  label,
  on,
  onPick,
}: {
  accountId: string | null;
  label: string;
  on: boolean;
  onPick: () => void;
}) {
  const usage = usePlanUsage({ accountId, enabled: false });
  const pct = usage.isError ? null : peakUsagePercent(usage.data ?? null);
  return (
    <MenuItem on={on} onClick={onPick}>
      {label}
      {pct !== null ? <span className="wf-mono"> · {Math.round(pct)}%</span> : null}
    </MenuItem>
  );
}
