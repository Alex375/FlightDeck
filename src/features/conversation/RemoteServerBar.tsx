// "The server this conversation runs on is down" — pinned above the composer, same
// visual family as `AuthWarningBar` and for the same reason: the alternative is finding
// out by sending a message that fails.
//
// The sidebar mark already turns red, but the mark is 13px of glyph seen out of the
// corner of the eye while you are reading a thread. Once you are IN the conversation and
// about to type, the thing deserves a sentence and a way out.
//
// NON-BLOCKING on purpose. The composer stays live and the message still sends. Our
// verdict is a snapshot taken up to a minute and a half ago by a probe that can be wrong
// (a server that came back, a network blip on our side); locking someone out of their
// own conversation on that would be a worse failure than the one it prevents. The bar
// states the risk plainly and offers the repair path — the decision stays the user's.
import { useConversationRepo } from "../../store/conversationsStore";
import { useMachines } from "../../store/conversationsStore";
import { isUnreachable, useMachineHealth } from "../../store/machineHealth";
import { useSettingsUi } from "../../store/settingsUi";

export function RemoteServerBar({ session }: { session: string }) {
  const repo = useConversationRepo(session);
  const machineId = repo?.machineId ?? null;
  const machines = useMachines();
  const health = useMachineHealth(machineId);
  const openSettings = useSettingsUi((s) => s.openSettings);

  // A local conversation, or a remote one we have no verdict on, says nothing at all —
  // the same "never on a guess" rule the mark itself follows.
  if (!machineId || !isUnreachable(health)) return null;

  const name = machines.find((m) => m.id === machineId)?.label ?? "This server";

  return (
    <div className="cv-reviewbar" data-tone="error">
      <span className="cv-reviewbar-dot" />
      <span className="cv-reviewbar-label">
        {name} is unreachable{health?.reason ? ` — ${health.reason}` : ""}. Messages to this agent will
        fail.
      </span>
      <button className="cv-reviewbar-btn" onClick={() => openSettings("control", "remote")}>
        Diagnose
      </button>
    </div>
  );
}
