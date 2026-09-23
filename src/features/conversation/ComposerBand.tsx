// "The server this conversation runs on is down", as the composer card's own header band
// (`.cv-sband`) — the same surface, tone and border tint the conversation's settled status
// uses since the status moved into the composer. Not a floating card above it: that is the
// pre-`cv-sband` design, and a warning that looked unlike every other composer band would
// read as a different KIND of thing.
//
// The sidebar mark already turns red, but the mark is 13px of glyph seen out of the corner
// of the eye while reading a thread. Once you are in the conversation and about to type,
// the thing deserves a sentence and a way out.
//
// NON-BLOCKING on purpose. The composer stays live and the message still sends. Our verdict
// is a snapshot taken up to a minute and a half ago by a probe that can be wrong (a server
// that came back, a blip on our side); locking someone out of their own conversation on
// that would be a worse failure than the one it prevents. The band states the risk plainly
// and offers the repair path — the decision stays the user's.
import { Ico } from "../../ui/kit";
import { useConversationRepo, useMachines } from "../../store/conversationsStore";
import { isUnreachable, useMachineHealth } from "../../store/machineHealth";
import { useSettingsUi } from "../../store/settingsUi";
import { ComposerStatusBand } from "./ComposerStatusBand";

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

/**
 * Which band sits at the top of the composer card — AT MOST ONE.
 *
 * ⚠️ `.cv-sband` is the card's HEADER: it pulls up into the card's padding and carries its
 * top corners, and the card tints its own border from it through `:has(> .cv-sband)`. Two
 * stacked would give the composer two rounded tops, a doubled border and two competing
 * tints. So this is a router, not a stack.
 *
 * An unreachable server WINS over the conversation's own settled status. Whatever that
 * status is, it is about a turn that already finished; the server being gone is about every
 * turn from here on. "Continue" would fail on the spot, and "Mark as seen" would tidy away
 * the colour while the real problem stayed invisible.
 *
 * Its own leaf, like `ComposerStatusBand` was: the composer never re-renders when either
 * the agent's status or a machine's health changes.
 */
export function ComposerBand({ session }: { session: string }) {
  const down = useUnreachableServer(session);
  const openSettings = useSettingsUi((s) => s.openSettings);

  if (!down) return <ComposerStatusBand session={session} />;

  return (
    <div className="cv-sband" data-tone="error" role="status">
      <Ico name="serverOff" className="cv-sband-ico" />
      <span className="cv-sband-label">{down.name} unreachable</span>
      <span className="cv-sband-sep">·</span>
      <span className="cv-sband-detail" title={down.reason ?? undefined}>
        {down.reason ? `${down.reason} — messages to this agent will fail` : "messages to this agent will fail"}
      </span>
      <span className="cv-sband-fill" />
      {/* Straight to the server panel, which already knows how to diagnose and repair it —
          the same destination the red mark in the sidebar leads to. */}
      <button
        type="button"
        className="cv-sband-btn"
        onClick={() => openSettings("control", "remote")}
        title="Open this server's panel in Settings — diagnosis and repairs"
      >
        <Ico name="pulse" className="sm" />
        Diagnose
      </button>
    </div>
  );
}
