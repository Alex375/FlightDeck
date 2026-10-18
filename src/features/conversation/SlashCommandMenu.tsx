// Slash-command autocomplete — the `/` menu in the composer.
//
// Modeled on the VS Code Claude Code extension (the project's behavioural
// reference): a popover opens above the composer the moment a `/` token is
// typed, filters live as you type, and is driven by ↑/↓ + Enter/Tab. Like the
// extension it stays clean — commands are grouped into sections, each row shows
// just the command name (the namespace lives in the section header), and the
// highlighted command's full signature + description sit in a footer.
//
// This file owns the pure pieces — slash-token detection, filtering, grouping —
// plus the presentational popover. Keyboard navigation lives in the composer
// (the single owner of the textarea), which keeps the menu purely declarative.

import { useEffect, useRef } from "react";
import type { SlashCommand } from "../../ipc/client";

/** A `/` token found under the caret: the text after the slash and its span. */
export interface SlashToken {
  /** Text after the `/` (the live filter), e.g. `"pick"` for `/pick`. */
  query: string;
  /** Index of the `/` character in the input. */
  start: number;
  /** Index just past the token. */
  end: number;
}

/**
 * Find a slash-command token under the caret, mirroring the extension's rule:
 * a `/` at the start of the input or after whitespace, followed by non-space,
 * non-slash characters (so it never fires mid-word or inside a path like `a/b`).
 * Returns null when the caret is not inside such a token.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const re = /(?:^|\s)\/[^\s/]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slash = text.indexOf("/", m.index);
    const end = m.index + m[0].length;
    if (caret >= slash && caret <= end) {
      return { query: text.slice(slash + 1, end), start: slash, end };
    }
  }
  return null;
}

/** Where a command comes from — the axis we group the `/` menu by, so you can
 *  see at a glance whether a command is this repo's own, a plugin's, or global.
 *
 *  There is NO scope field on the wire: the CLI encodes the origin as a hint in
 *  the `initialize` command's description (verified live on 2.1.187):
 *   - a repo-local `.claude/skills` skill ends its description with `(project)`;
 *   - a plugin skill carries a LEADING `(plugin-name)` hint (its `name` is bare,
 *     e.g. `pickup`), or uses a `plugin:command` name as a fallback shape;
 *   - a dynamic workflow ends with `(dynamic workflow)` — not a plugin;
 *   - everything else (built-ins + the user's own `~/.claude/skills`) has no
 *     hint and lands in the general "Commandes" bucket. */
export type CommandScope =
  | { kind: "project" }
  | { kind: "plugin"; plugin: string }
  | { kind: "global" };

/** The `(x)` hint the CLI prepends to a description, or "" when there is none. */
function leadingHint(desc: string): string {
  const m = desc.match(/^\s*\(([^)]+)\)/);
  return m ? m[1].trim() : "";
}

/** The `(x)` hint the CLI appends to a description, or "" when there is none. Index scans,
 *  not an end-anchored regex: the description is the CLI's (a server's, for a remote
 *  conversation), and `/\(([^)]+)\)\s*$/` over a long run of "(" is quadratic. Same answer:
 *  the text between the EARLIEST "(" after the last inner ")" and the closing ")". */
function trailingHint(desc: string): string {
  const d = desc.trimEnd();
  if (!d.endsWith(")")) return "";
  const inner = d.slice(0, -1);
  const open = inner.indexOf("(", inner.lastIndexOf(")") + 1);
  return open < 0 || open === inner.length - 1 ? "" : inner.slice(open + 1).trim();
}

/** The scope markers the CLI appends to a description (lower-case), see {@link cleanDescription}. */
const TRAILING_SCOPE_MARKERS = ["(project)", "(dynamic workflow)"];

/** Classify a command by origin (see {@link CommandScope}). Plugin membership is
 *  checked first (leading hint / `plugin:` name), then the repo-local `(project)`
 *  marker, else it is a general command. */
export function commandScope(cmd: SlashCommand): CommandScope {
  const colon = cmd.name.indexOf(":");
  if (colon >= 0) return { kind: "plugin", plugin: cmd.name.slice(0, colon) };
  const lead = leadingHint(cmd.description);
  if (lead && lead.toLowerCase() !== "dynamic workflow") return { kind: "plugin", plugin: lead };
  if (trailingHint(cmd.description).toLowerCase() === "project") return { kind: "project" };
  return { kind: "global" };
}

/** Stable identity of a scope — used both to chunk contiguous groups and as a
 *  React key. Distinct per plugin so each plugin gets its own section. */
function scopeId(scope: CommandScope): string {
  return scope.kind === "plugin" ? `plugin:${scope.plugin}` : scope.kind;
}

/** Section header title for a scope (French UI). */
function scopeTitle(scope: CommandScope): string {
  switch (scope.kind) {
    case "project":
      return "Projet";
    case "plugin":
      return scope.plugin;
    case "global":
      return "Commandes";
  }
}

/** Sort key ordering the sections: this repo's skills first (most relevant to
 *  where you are), then the general commands, then plugins A→Z. */
function scopeSortKey(scope: CommandScope): string {
  if (scope.kind === "project") return "0";
  if (scope.kind === "global") return "1";
  return "2:" + scope.plugin.toLowerCase();
}

/** The label shown in a row: the bare command, since the section header already
 *  carries the namespace (`/pickup` under a "tosse-workflow" header). */
export function commandLabel(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Drop the origin hints the CLI adds to skill descriptions — redundant with the
 *  section header. A LEADING `(source)` hint (plugin / dynamic workflow) and a
 *  TRAILING scope marker (`(project)` / `(dynamic workflow)`) are removed; a
 *  meaningful trailing parenthetical (e.g. `clear` → "resumable with /resume")
 *  is kept. */
export function cleanDescription(desc: string): string {
  const d = desc.replace(/^\s*\([^)]*\)\s*/, "").trimEnd();
  // A suffix test, not `/\s*\((?:project|…)\)\s*$/i`: that regex is quadratic over a long
  // inner run of spaces (see `trailingHint`).
  const lower = d.toLowerCase();
  const marker = TRAILING_SCOPE_MARKERS.find((m) => lower.endsWith(m));
  return (marker ? d.slice(0, -marker.length) : d).trim();
}

/** Is `text` an invocation of the native `/reload-skills` command? True when the
 *  whole input is that command (leading/trailing space or args tolerated). The
 *  composer uses this to refresh the `/` menu after the CLI reloads skills from
 *  disk. */
export function isReloadSkillsCommand(text: string): boolean {
  return text.trim().split(/\s+/, 1)[0] === "/reload-skills";
}

/** Does `q` appear as an in-order subsequence of `s`? (loose fuzzy match) */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Lower rank = better match; -1 = no match. */
function score(name: string, desc: string, q: string): number {
  const bare = commandLabel(name);
  if (name === q || bare === q) return 0; // exact
  if (name.startsWith(q) || bare.startsWith(q)) return 1; // prefix
  if (name.includes(q)) return 2; // substring
  if (isSubsequence(q, name)) return 3; // fuzzy on name
  if (desc.includes(q)) return 4; // description fallback
  return -1;
}

/**
 * Filter + order commands for a query (the text after `/`). Results are ordered
 * by scope ("Projet", then "Commandes", then plugins A→Z) so each is contiguous;
 * within a section, by match relevance (exact → prefix → substring → fuzzy →
 * description) then alphabetically. An empty query lists everything, grouped and
 * alphabetical. The returned flat order matches the on-screen order, so the
 * composer can drive selection by a single flat index.
 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  return commands
    .map((cmd) => ({
      cmd,
      scopeSort: scopeSortKey(commandScope(cmd)),
      rank: q ? score(cmd.name.toLowerCase(), cmd.description.toLowerCase(), q) : 0,
    }))
    .filter((s) => s.rank >= 0)
    .sort(
      (a, b) =>
        a.scopeSort.localeCompare(b.scopeSort) ||
        a.rank - b.rank ||
        a.cmd.name.localeCompare(b.cmd.name),
    )
    .map((s) => s.cmd);
}

interface CommandGroup {
  /** Stable scope identity — the React key and contiguity boundary. */
  id: string;
  title: string;
  /** Flat index of this group's first item (for keyboard-selection mapping). */
  start: number;
  items: SlashCommand[];
}

/** Chunk an already-section-ordered flat list into contiguous groups. */
function groupSlashCommands(list: SlashCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  let current: CommandGroup | null = null;
  list.forEach((cmd, idx) => {
    const scope = commandScope(cmd);
    const id = scopeId(scope);
    if (!current || current.id !== id) {
      current = { id, title: scopeTitle(scope), start: idx, items: [] };
      groups.push(current);
    }
    current.items.push(cmd);
  });
  return groups;
}

export function SlashCommandMenu({
  items,
  activeIndex,
  onHover,
  onPick,
}: {
  items: SlashCommand[];
  activeIndex: number;
  /** Hovering a row makes it active (so Enter then picks it). */
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the active row in view as ↑/↓ moves the selection.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const groups = groupSlashCommands(items);
  const active = items[activeIndex];
  const activeDesc = active ? cleanDescription(active.description) || active.description : "";

  return (
    <div className="cv-slash" role="listbox" aria-label="Commandes">
      <div className="cv-slash-list">
        {groups.map((g) => (
          <div className="cv-slash-group" key={g.id}>
            <div className="cv-slash-head">{g.title}</div>
            {g.items.map((cmd, li) => {
              const i = g.start + li;
              return (
                <button
                  key={cmd.name}
                  ref={i === activeIndex ? activeRef : null}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={"cv-slash-item" + (i === activeIndex ? " on" : "")}
                  // mousedown (not click) so the textarea never loses focus first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(cmd);
                  }}
                  onMouseMove={() => onHover(i)}
                  title={cleanDescription(cmd.description) || cmd.description || undefined}
                >
                  <span className="cv-slash-name">/{commandLabel(cmd.name)}</span>
                  {cmd.argument_hint ? (
                    <span className="cv-slash-arg wf-mono">{cmd.argument_hint}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {active ? (
        <div className="cv-slash-foot">
          <span className="cv-slash-foot-cmd wf-mono">
            /{active.name}
            {active.argument_hint ? ` ${active.argument_hint}` : ""}
          </span>
          {activeDesc ? <span className="cv-slash-foot-desc">{activeDesc}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
