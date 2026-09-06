// The built-in Claude Code output styles surfaced in the app.
//
// Output style is a USER-GLOBAL Claude setting (`~/.claude/settings.json` `outputStyle`) —
// the CLI has no per-session style — so one value serves the whole app. The live/active
// value the running binary reports travels on `SessionStatePayload.output_style`; the
// persisted choice is read/written through the `get_output_style`/`set_output_style` IPC.
//
// The CLI also supports CUSTOM styles (dropped into `~/.claude/output-styles/`), but it
// does NOT advertise the available list on `system/init`'s stdout, so we surface the five
// built-ins — the same curation stance as the static Claude model list. A custom style set
// by hand still round-trips: `outputStyleLabel` shows its raw name, and picking a built-in
// afterwards stays possible.
//
// Each `id` is written VERBATIM to settings.json (the CLI does not normalise casing).
// `DEFAULT_OUTPUT_STYLE` ("default") means "no key" — see `extensions::set_output_style`,
// which REMOVES the key for it rather than writing `"outputStyle":"default"`.

export const DEFAULT_OUTPUT_STYLE = "default";

export interface OutputStyleOption {
  /** The exact value written to settings.json `outputStyle`. */
  id: string;
  label: string;
  desc: string;
}

export const OUTPUT_STYLES: readonly OutputStyleOption[] = [
  { id: "default", label: "Default", desc: "Claude's standard responses." },
  {
    id: "Concise",
    label: "Concise",
    desc: "Result first, no preamble — but keeps errors, warnings and destructive confirmations in full.",
  },
  {
    id: "Proactive",
    label: "Proactive",
    desc: "Anticipates the next steps and suggests follow-ups as it works.",
  },
  {
    id: "Explanatory",
    label: "Explanatory",
    desc: "Explains the reasoning and the trade-offs behind the code as it goes.",
  },
  {
    id: "Learning",
    label: "Learning",
    desc: "Collaborative — teaches as it works and leaves you hands-on steps to complete.",
  },
] as const;

/** The label to show for a stored style id: a built-in maps to its label; a custom style
 *  (or an unknown future built-in) shows its raw name; empty / "default" → "Default". */
export function outputStyleLabel(id: string | null | undefined): string {
  if (!id || id === DEFAULT_OUTPUT_STYLE) return "Default";
  return OUTPUT_STYLES.find((s) => s.id === id)?.label ?? id;
}
