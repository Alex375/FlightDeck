// The expanded tool list of a Claude MCP server, with a permission per tool:
// Default / Allow / Ask / Block — Claude Code's own permission rules. Two scopes share this
// component (see mcpToolPermissions.ts):
//   • global (Settings → Extensions): the user's ~/.claude/settings.json, every conversation;
//   • conversation (its ⌘E panel): that conversation's session layer, it alone.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { McpServerLive, McpToolInfo, ToolRuleKind } from "../../ipc/client";
import { useMcpPermissionRules, useSetMcpToolPermissions } from "../../ipc/useExtensions";
import { applyConvToolPermissions, convToolRules, useConvToolPermissions } from "../../store/convToolPermissions";
import {
  TOOL_CHOICES,
  describeRule,
  mcpToolRuleName,
  readOnlyPreset,
  resetServer,
  serverSummary,
  setAll,
  toolNature,
  toolPermissionState,
  type PermissionScope,
  type ToolChange,
  type ToolChoice,
  type ToolPermissionState,
  type ToolRule,
} from "./mcpToolPermissions";
import styles from "./ExtensionsManager.module.css";

const CHOICE_LABEL: Record<ToolChoice, string> = { default: "Default", allow: "Allow", ask: "Ask", deny: "Block" };
const KIND_LABEL: Record<ToolRuleKind, string> = { allow: "Allow", ask: "Ask", deny: "Block" };

/** Everything a panel needs to show and change one scope's rules. */
export interface PermissionTarget {
  scope: PermissionScope;
  /** Every rule that applies (files + the conversation's own); undefined while loading. */
  rules: ToolRule[] | undefined;
  loadError: string | null;
  /** Settings files that couldn't be read — a rule in them may apply unseen. */
  warnings: string[];
  /** Why this scope can't be changed right now (null: it can). */
  readOnlyReason: string | null;
  apply: (changes: ToolChange[]) => void;
  pending: boolean;
  error: string | null;
  /** Shown above the list: what this scope reaches. */
  hint: string;
}

/** The global scope: the user's settings file, evaluated with `repoPath`'s files too (null:
 *  only the files that don't depend on a project). */
export function useGlobalPermissionTarget(repoPath: string | null): PermissionTarget {
  const rules = useMcpPermissionRules(repoPath);
  const set = useSetMcpToolPermissions();
  return {
    scope: "global",
    rules: rules.data?.rules,
    loadError: rules.isError ? (rules.error as Error).message : null,
    warnings: (rules.data?.warnings ?? []).filter((w) => w !== rules.data?.user_error),
    readOnlyReason: rules.data?.user_error
      ? `Your settings file can't be read, so it can't be changed from here: ${rules.data.user_error}`
      : null,
    apply: (changes) => set.mutate(changes),
    pending: set.isPending,
    error: set.isError ? (set.error as Error).message : null,
    hint: "Global — every conversation, and Claude Code in the terminal. Saved in ~/.claude/settings.json; applies from the next tool call.",
  };
}

/** The conversation scope: that conversation's own rules, on top of the files'. */
export function useConversationPermissionTarget(
  repoPath: string,
  convId: string,
  handle: string | null,
): PermissionTarget {
  const files = useMcpPermissionRules(repoPath);
  const byConv = useConvToolPermissions((s) => s.byConv);
  const apply = useMutation({
    mutationFn: (changes: ToolChange[]) => applyConvToolPermissions(convId, handle, changes),
  });
  return {
    scope: "conversation",
    rules: files.data ? [...files.data.rules, ...convToolRules(byConv, convId)] : undefined,
    loadError: files.isError ? (files.error as Error).message : null,
    warnings: files.data?.warnings ?? [],
    readOnlyReason: null,
    apply: (changes) => apply.mutate(changes),
    pending: apply.isPending,
    error: apply.isError ? (apply.error as Error).message : null,
    hint: "This conversation only — on top of your global rules (Settings → Extensions). It can tighten them, never loosen them.",
  };
}

/** The server's tools with their metadata; plain names when the session gave none. */
export function toolsOf(server: McpServerLive): McpToolInfo[] {
  return server.tool_info?.length
    ? server.tool_info
    : server.tools.map((name) => ({ name, description: null, read_only: null, destructive: null }));
}

/** "Block 2 · Ask 3" — what the rules do to a server's tools, for its collapsed row. */
export function McpPermissionSummary({ server, rules }: { server: McpServerLive; rules: ToolRule[] | undefined }) {
  const s = serverSummary(server.name, toolsOf(server), rules);
  const parts = (["deny", "ask", "allow"] as const).filter((k) => s[k] > 0).map((k) => `${KIND_LABEL[k]} ${s[k]}`);
  if (!parts.length) return null;
  return (
    <span className={styles.permSummary} title="Tools of this server with a permission rule">
      {parts.join(" · ")}
    </span>
  );
}

function choiceTitle(c: ToolChoice, s: ToolPermissionState, scope: PermissionScope): string {
  const o = s.options[c];
  if (!o.holds && o.blockedBy) return `Not available: ${describeRule(o.blockedBy)} takes precedence.`;
  switch (c) {
    case "default":
      if (s.inherited.kind && s.inherited.rule)
        return `No rule here — "${KIND_LABEL[s.inherited.kind]}" applies from ${describeRule(s.inherited.rule)}.`;
      return scope === "conversation"
        ? "No rule here — your global rules apply, and without one the permission mode decides."
        : "No rule — the conversation's permission mode decides. In Auto mode the classifier may run it without asking.";
    case "allow":
      return "Runs without asking, in every permission mode.";
    case "ask":
      return "Asks before every call — even in Auto and Bypass permissions modes.";
    case "deny":
      return "Hidden from Claude: it can't call this tool, in any mode.";
  }
}

function ToolRow({
  server,
  tool,
  rules,
  scope,
  disabled,
  onChoose,
}: {
  server: string;
  tool: McpToolInfo;
  rules: ToolRule[];
  scope: PermissionScope;
  disabled: boolean;
  onChoose: (rule: string, choice: ToolChoice) => void;
}) {
  const rule = mcpToolRuleName(server, tool.name);
  const s = toolPermissionState(rule, rules, scope);
  const nature = toolNature(tool);
  // The panel's own rule no longer being what applies (a stricter one appeared elsewhere).
  const overridden = s.choice !== "default" && s.effective.kind !== s.choice;
  return (
    <div className={styles.permRow}>
      <div className={styles.permName}>
        <span className={styles.permTool} title={tool.description ?? rule}>
          {tool.name}
        </span>
        <span
          className={`${styles.permNature} ${nature.from === "name" ? styles.permNatureGuess : ""}`}
          title={
            nature.from === "annotation"
              ? "As declared by the server"
              : "Guessed from the tool's name — the server doesn't say"
          }
        >
          {nature.nature}
        </span>
      </div>
      <div className={styles.permSeg} role="radiogroup" aria-label={`Permission for ${tool.name}`}>
        {TOOL_CHOICES.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={s.choice === c}
            className={`${styles.permOpt} ${s.choice === c ? styles.permOptOn : ""} ${styles[`permOpt_${c}`] ?? ""}`}
            disabled={disabled || !s.options[c].holds}
            title={choiceTitle(c, s, scope)}
            onClick={() => s.choice !== c && onChoose(rule, c)}
          >
            {CHOICE_LABEL[c]}
          </button>
        ))}
      </div>
      {overridden && s.effective.kind && s.effective.rule ? (
        <div className={styles.permNote + " " + styles.permNoteWarn}>
          Overridden — {KIND_LABEL[s.effective.kind]} applies from {describeRule(s.effective.rule)}
        </div>
      ) : s.choice === "default" && s.inherited.kind && s.inherited.rule ? (
        <div className={styles.permNote}>
          → {KIND_LABEL[s.inherited.kind]} · {describeRule(s.inherited.rule)}
        </div>
      ) : null}
    </div>
  );
}

export function McpToolPermissions({ server, target }: { server: McpServerLive; target: PermissionTarget }) {
  const tools = toolsOf(server);
  const [notice, setNotice] = useState<string | null>(null);
  if (target.loadError) {
    return <div className={styles.error}>Unable to read the permission rules: {target.loadError}</div>;
  }
  if (!target.rules) return <div className={styles.permMsg}>Reading permission rules…</div>;
  const rules = target.rules;
  const scope = target.scope;
  const disabled = target.readOnlyReason != null || target.pending;
  const run = ({ changes, skipped }: { changes: ToolChange[]; skipped: number }) => {
    setNotice(
      skipped
        ? `${skipped} tool${skipped > 1 ? "s" : ""} left as is: a stricter rule elsewhere applies.`
        : changes.length
          ? null
          : "Nothing to change.",
    );
    if (changes.length) target.apply(changes);
  };
  const resetChanges = resetServer(server.name, tools, rules, scope);
  const all = (kind: ToolRuleKind) => run(setAll(server.name, tools, rules, kind, scope));
  return (
    <div className={styles.permPanel}>
      <div className={styles.permHint}>{target.hint}</div>
      <div className={styles.permBar}>
        <button
          className={styles.actBtn}
          disabled={disabled}
          onClick={() => run(readOnlyPreset(server.name, tools, rules, scope))}
          title="Allow the tools that only read; every other tool asks before running."
        >
          Read-only
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => all("allow")} title="Allow every tool of this server.">
          Allow all
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => all("ask")} title="Ask before every call to this server.">
          Ask for all
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => all("deny")} title="Hide every tool of this server from Claude.">
          Block all
        </button>
        <button
          className={styles.actBtn}
          disabled={disabled || resetChanges.length === 0}
          onClick={() => {
            setNotice(null);
            target.apply(resetChanges);
          }}
          title="Remove the rules set here for this server's tools (back to Default)."
        >
          Reset
        </button>
      </div>
      {target.readOnlyReason ? <div className={styles.error}>{target.readOnlyReason}</div> : null}
      {target.warnings.length ? (
        <div className={styles.warn}>
          Some settings files couldn't be read — a rule in them may apply without showing here:
          <ul>
            {target.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {target.error ? <div className={styles.error}>{target.error}</div> : null}
      {notice ? <div className={styles.permMsg}>{notice}</div> : null}
      <div className={styles.permList}>
        {tools.map((t) => (
          <ToolRow
            key={t.name}
            server={server.name}
            tool={t}
            rules={rules}
            scope={scope}
            disabled={disabled}
            onChoose={(tool, choice) => {
              setNotice(null);
              target.apply([{ tool, kind: choice === "default" ? null : choice }]);
            }}
          />
        ))}
      </div>
    </div>
  );
}
