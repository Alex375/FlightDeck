// Settings → Behavior → "Output style". Picks the GLOBAL Claude output style — how the
// assistant writes its responses (Default / Concise / …). It writes `~/.claude/settings.json`
// `outputStyle` through the `set_output_style` IPC, so it takes effect for every
// conversation (the CLI has no per-session style). The same value drives the composer's
// output-style chip; changing it here updates the chip and vice-versa.
import { useOutputStyle, useSetOutputStyle } from "../../ipc/useOutputStyle";
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLES } from "../conversation/outputStyles";
import { OptionCardRail, SettingsGroup } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function OutputStylePrefs() {
  const { data, error } = useOutputStyle();
  const setStyle = useSetOutputStyle();
  const current = data ?? DEFAULT_OUTPUT_STYLE;

  // A read that failed (a broken settings.json) or a write that failed (read-only home)
  // is surfaced, never swallowed — the user must not think a style is set when it isn't.
  const problem = error
    ? `Couldn't read the output style: ${error instanceof Error ? error.message : String(error)}`
    : setStyle.isError
      ? `Couldn't save the output style: ${
          setStyle.error instanceof Error ? setStyle.error.message : String(setStyle.error)
        }`
      : null;

  return (
    <SettingsGroup title="Output style" icon="pencil">
      <OptionCardRail
        className={styles.behaviorRail}
        options={OUTPUT_STYLES}
        selected={current}
        onSelect={(id) => {
          if (id !== current) setStyle.mutate(id);
        }}
        ariaLabel="Output style"
      />
      <div className={styles.note} style={{ marginTop: 10 }}>
        Also reachable from the composer's output-style chip.
      </div>
      {problem ? (
        <div className={styles.thint} style={{ marginTop: 8, color: "var(--wf-err, #d66)" }}>
          {problem}
        </div>
      ) : null}
    </SettingsGroup>
  );
}
