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
import { Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useSessionState } from "../../store/conversationStore";
import { useOutputStyle, useSetOutputStyle } from "../../ipc/useOutputStyle";
import { OutputStyleFace } from "./composerChipFaces";
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLES, outputStyleLabel } from "./outputStyles";

export function OutputStyleChip({ session }: { session: string }) {
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
