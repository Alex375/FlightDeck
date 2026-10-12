// The composer's output-style chip — a self-contained face + menu, like GoalChip /
// ArtifactsChip. Output style is a USER-GLOBAL Claude setting, so this chip reads and
// writes the ONE global value (via the shared `useOutputStyle` query) rather than a
// per-conversation control: picking a style here changes it for every conversation, and
// every conversation's chip reflects it.
//
// It lives on the composer bar as a normal RIGHT chip (see composerLayout.ts), so it is
// hidden / reordered through Settings → Composer like the others — no separate visibility
// pref. Claude only (Codex has no output style); the bar's backend filter keeps it off
// Codex conversations, so no guard is needed here.
//
// On a conversation running on a paired SERVER the chip is READ-ONLY: that `claude` reads the
// SERVER's settings.json, so a pick here (which writes THIS Mac's) would never reach it — and
// the "active next turn" hint would then sit there forever. It shows what the session itself
// reports (`system/init`'s output_style) and says where the style is set.
import { Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useSessionState } from "../../store/conversationStore";
import { useOutputStyle, useSetOutputStyle } from "../../ipc/useOutputStyle";
import { OutputStyleFace } from "./composerChipFaces";
import { useConvServer } from "./ConvMark";
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLES, outputStyleLabel } from "./outputStyles";

export function OutputStyleChip({ session }: { session: string }) {
  const server = useConvServer(session);
  return server ? (
    <ServerOutputStyleChip session={session} server={server} />
  ) : (
    <LocalOutputStyleChip session={session} />
  );
}

function LocalOutputStyleChip({ session }: { session: string }) {
  const { data } = useOutputStyle();
  const setStyle = useSetOutputStyle();
  const current = data ?? DEFAULT_OUTPUT_STYLE;
  // The style the RUNNING binary actually reports right now (from system/init, re-emitted
  // each turn). When it differs from the picked global value, the change hasn't reached
  // this live session yet — say so rather than let the chip imply it's already active.
  const live = useSessionState(session)?.output_style ?? null;
  const pending = live != null && live !== current;

  return (
    <Menu
      up
      trigger={
        <OutputStyleFace
          label={outputStyleLabel(current)}
          title="Output style — how Claude writes its responses (global)"
        />
      }
    >
      {/* Labels only, like the model picker — the full descriptions live in the richer
          Settings → Behavior → Output style card. */}
      <MenuLabel>Output style</MenuLabel>
      {OUTPUT_STYLES.map((s) => (
        <MenuItem
          key={s.id}
          on={current === s.id}
          onClick={() => {
            if (s.id !== current) setStyle.mutate(s.id);
          }}
        >
          {s.label}
        </MenuItem>
      ))}
      {pending ? (
        <MenuItem disabled>{`Active next turn (running as "${outputStyleLabel(live)}")`}</MenuItem>
      ) : null}
    </Menu>
  );
}

/** The read-only menu's sentence. Nothing can be chosen there, so it says where the style IS set
 *  — and, before the session has reported it, when it will show. */
export function serverOutputStyleNote(server: string, known: boolean): string {
  return known
    ? `Set on ${server}, in its Claude settings — this Mac's setting doesn't apply here.`
    : `Set on ${server}, in its Claude settings. The style shows here once the conversation has started.`;
}

/** Read-only: the style the server's session reports, and where it is set. Never reads or
 *  writes this Mac's settings.json. */
function ServerOutputStyleChip({ session, server }: { session: string; server: string }) {
  // Known once the session has reported (`system/init`, re-sent each turn); before the first
  // turn there is nothing to show but where the style comes from.
  const live = useSessionState(session)?.output_style ?? null;
  const label = live != null ? outputStyleLabel(live) : `Set on ${server}`;
  return (
    <Menu
      up
      trigger={
        <OutputStyleFace label={label} title={`Output style — set on ${server}, in its Claude settings`} />
      }
    >
      <MenuLabel>Output style</MenuLabel>
      {live != null ? <MenuItem on>{outputStyleLabel(live)}</MenuItem> : null}
      {/* A sentence, not a row: a disabled row dims and takes no pointer events (see .cv-perm-note). */}
      <div className="cv-perm-note">{serverOutputStyleNote(server, live != null)}</div>
    </Menu>
  );
}
