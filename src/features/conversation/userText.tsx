// Rendering of a USER message's text. A slash-command invocation reaches us wrapped by
// the CLI as `<command-message>…</command-message><command-name>/foo</command-name>
// <command-args>…</command-args>` — raw noise the user shouldn't read. We surface it as a
// clean command chip instead. Shared by the live thread (MsgUser) and the disk transcript
// (SubAgentTranscript) so both render commands identically.
//
// A skill the MODEL invokes goes through a different wire shape: a `Skill` tool_use (not a
// user turn), so it's surfaced by a sister renderer (SkillChip) off the tool input — see
// parseSkillInvocation. Both funnel into the same `.cv-cmd` affordance so "/done" reads
// identically whether the human typed it or the agent invoked it.
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { Ico } from "../../ui/kit";

const NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/** A slash-command as the user actually TYPED it, before the CLI wraps it: the whole
 *  message is one line opening on `/name`, optionally followed by arguments.
 *
 *  Needed for live/reload parity: the optimistic bubble we append on send holds the raw
 *  "/compact" the user typed (or a button sent), while the SAME turn read back from the
 *  transcript holds the CLI's `<command-name>` wrapper. Without this, one command rendered
 *  as grey raw text live and as a chip after a reload.
 *
 *  The name may not contain `/`, which is what keeps a path from being mistaken for a
 *  command: "/Users/alex/notes.md" fails, "/compact" and "/tosse-workflow:pickup" pass. */
const BARE_RE = /^\/([A-Za-z0-9][\w:.-]*)(?:[ \t]+([^\n]*))?$/;

/** Pull the command + args out of a slash-command message, in either shape (CLI-wrapped or
 *  as typed); `null` when the text isn't a command invocation (a normal prompt). */
export function parseSlashCommand(text: string): { command: string; args: string } | null {
  const m = NAME_RE.exec(text);
  if (!m) {
    const bare = BARE_RE.exec(text.trim());
    return bare ? { command: "/" + bare[1], args: (bare[2] ?? "").trim() } : null;
  }
  let command = m[1].trim();
  if (!command) return null;
  if (!command.startsWith("/")) command = "/" + command;
  const a = ARGS_RE.exec(text);
  const args = a ? a[1].trim() : "";
  return { command, args };
}

/** The clean one-line form of a user message for previews (pin / Flight Deck peek): a
 *  slash-command collapses to `/command args`, dropping the CLI's `<command-message>…
 *  </command-name>` wrapper that would otherwise leak into the preview as raw tags. Any
 *  other message is returned unchanged. Twin of `UserText`'s chip, for the plain-text
 *  surfaces that can't render a chip. */
export function userMessagePreviewText(text: string): string {
  const cmd = parseSlashCommand(text);
  if (!cmd) return text;
  return cmd.args ? `${cmd.command} ${cmd.args}` : cmd.command;
}

/** A user message's text: a slash-command shows as a clean chip (the `<command-*>` wrapper
 *  is dropped), everything else renders as-is. */
export function UserText({ text }: { text: string }) {
  const cmd = parseSlashCommand(text);
  // A plain prompt keeps its line breaks: the raw text carries `\n`, but HTML collapses
  // whitespace by default, so we render it in a `white-space: pre-wrap` span (the fix for
  // "my newlines vanish once I hit send"). A slash-command shows as a chip instead.
  if (!cmd) return <span className="cv-user-text">{text}</span>;
  return (
    <span className="cv-cmd">
      <Ico name="wand" className="sm" />
      <span className="cv-cmd-name">{cmd.command}</span>
      {cmd.args ? <span className="cv-cmd-args">{cmd.args}</span> : null}
    </span>
  );
}

/** Read a model-invoked skill's command out of a `Skill` tool_use input. The `skill` field is
 *  the fully-qualified id the model called (`tosse-workflow:done`, `start`, `code-review`); we
 *  present it as the command a human would type — drop any `plugin:` namespace (everything up
 *  to and including the last `:`) and prefix a slash: `tosse-workflow:done` → `/done`,
 *  `start` → `/start`. `qualified` keeps the full id for a disambiguating tooltip. `null` when
 *  the input carries no skill. */
export function parseSkillInvocation(
  input: JsonValue,
): { command: string; qualified: string; args: string } | null {
  const skill = field(input, "skill");
  if (!skill || !skill.trim()) return null;
  const qualified = skill.trim();
  const short = qualified.slice(qualified.lastIndexOf(":") + 1);
  const args = (field(input, "args") ?? "").trim();
  return { command: "/" + short, qualified, args };
}

/** A skill the model invoked (the `Skill` tool), shown as a dedicated command chip — the SAME
 *  `.cv-cmd` affordance as a user-typed slash-command, so the agent's `/done` reads like a
 *  command, never a raw tool card. Shared by the live thread and the disk transcript. */
export function SkillChip({ input }: { input: JsonValue }) {
  const inv = parseSkillInvocation(input);
  if (!inv) return null;
  // Show the qualified id on hover only when it adds information (a plugin command whose short
  // form hides its namespace); a bare project skill's tooltip would just echo the chip.
  const title = "/" + inv.qualified !== inv.command ? inv.qualified : undefined;
  return (
    <span className="cv-skill">
      <span className="cv-cmd" title={title}>
        <Ico name="wand" className="sm" />
        <span className="cv-cmd-name">{inv.command}</span>
        {inv.args ? <span className="cv-cmd-args">{inv.args}</span> : null}
      </span>
    </span>
  );
}
