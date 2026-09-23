// The expanded tool list of a live Claude MCP server, with a permission per tool:
// Default / Allow / Ask / Block — Claude Code's own permission rules, written to the
// user's ~/.claude/settings.json (see mcpToolPermissions.ts for the resolution rules).
import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { McpServerLive, McpToolInfo, PermissionRulesView, ToolRuleKind } from "../../ipc/client";
import type { useSetMcpToolPermissions } from "../../ipc/useExtensions";
import {
  TOOL_CHOICES,
  describeRule,
  mcpToolRuleName,
  readOnlyPreset,
  resetServer,
  serverSummary,
  toolNature,
  toolPermissionState,
  type ToolChoice,
  type ToolPermissionState,
} from "./mcpToolPermissions";
import styles from "./ExtensionsManager.module.css";

const CHOICE_LABEL: Record<ToolChoice, string> = { default: "Default", allow: "Allow", ask: "Ask", deny: "Block" };
const KIND_LABEL: Record<ToolRuleKind, string> = { allow: "Allow", ask: "Ask", deny: "Block" };

/** The server's tools with their metadata; plain names when the session gave none. */
export function toolsOf(server: McpServerLive): McpToolInfo[] {
  return server.tool_info?.length
    ? server.tool_info
    : server.tools.map((name) => ({ name, description: null, read_only: null, destructive: null }));
}

/** "Block 2 · Ask 3" — what the rules do to a server's tools, for its collapsed row. */
export function McpPermissionSummary({ server, view }: { server: McpServerLive; view: PermissionRulesView | undefined }) {
  const s = serverSummary(server.name, toolsOf(server), view);
  const parts = (["deny", "ask", "allow"] as const).filter((k) => s[k] > 0).map((k) => `${KIND_LABEL[k]} ${s[k]}`);
  if (!parts.length) return null;
  return (
    <span className={styles.permSummary} title="Tools of this server with a permission rule">
      {parts.join(" · ")}
    </span>
  );
}

function choiceTitle(c: ToolChoice, s: ToolPermissionState): string {
  const o = s.options[c];
  if (!o.holds && o.blockedBy) return `Not available: ${describeRule(o.blockedBy)} takes precedence.`;
  switch (c) {
    case "default":
      return s.inherited.kind && s.inherited.rule
        ? `No rule of yours — "${KIND_LABEL[s.inherited.kind]}" applies from ${describeRule(s.inherited.rule)}.`
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
  view,
  disabled,
  onChoose,
}: {
  server: string;
  tool: McpToolInfo;
  view: PermissionRulesView;
  disabled: boolean;
  onChoose: (rule: string, choice: ToolChoice) => void;
}) {
  const rule = mcpToolRuleName(server, tool.name);
  const s = toolPermissionState(rule, view.rules);
  const nature = toolNature(tool);
  // The user's own rule no longer being what applies (a stricter one appeared elsewhere).
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
            title={choiceTitle(c, s)}
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

export function McpToolPermissions({
  server,
  rules,
  setPerms,
}: {
  server: McpServerLive;
  rules: UseQueryResult<PermissionRulesView>;
  setPerms: ReturnType<typeof useSetMcpToolPermissions>;
}) {
  const tools = toolsOf(server);
  const [notice, setNotice] = useState<string | null>(null);
  if (rules.isLoading) return <div className={styles.permMsg}>Reading permission rules…</div>;
  if (rules.isError || !rules.data) {
    return (
      <div className={styles.error}>
        Unable to read the permission rules: {(rules.error as Error | null)?.message ?? "unknown error"}
      </div>
    );
  }
  const view = rules.data;
  const writable = view.user_error == null;
  const disabled = !writable || setPerms.isPending;
  const apply = (changes: { tool: string; kind: ToolRuleKind | null }[], after?: string) => {
    setNotice(null);
    if (!changes.length) {
      setNotice(after ?? "Nothing to change.");
      return;
    }
    setPerms.mutate(changes, { onSuccess: () => after && setNotice(after) });
  };
  const preset = () => {
    const { changes, skipped } = readOnlyPreset(server.name, tools, view.rules);
    apply(
      changes,
      skipped ? `${skipped} tool${skipped > 1 ? "s" : ""} left as is: a stricter rule elsewhere applies.` : undefined,
    );
  };
  const resetChanges = resetServer(server.name, tools, view.rules);
  return (
    <div className={styles.permPanel}>
      <div className={styles.permBar}>
        <span className={styles.permHint}>
          Saved in ~/.claude/settings.json — applies to every conversation (and to Claude Code in the terminal)
          from the next tool call.
        </span>
        <button
          className={styles.actBtn}
          disabled={disabled}
          onClick={preset}
          title="Allow the tools that only read; every other tool asks before running."
        >
          Read-only
        </button>
        <button
          className={styles.actBtn}
          disabled={disabled || resetChanges.length === 0}
          onClick={() => apply(resetChanges)}
          title="Remove your rules for this server's tools (back to Default)."
        >
          Reset
        </button>
      </div>
      {view.user_error ? (
        <div className={styles.error}>
          Your settings file can't be read, so it can't be changed from here: {view.user_error}
        </div>
      ) : null}
      {view.warnings.filter((w) => w !== view.user_error).length ? (
        <div className={styles.warn}>
          Some settings files couldn't be read — a rule in them may apply without showing here:
          <ul>
            {view.warnings
              .filter((w) => w !== view.user_error)
              .map((w) => (
                <li key={w}>{w}</li>
              ))}
          </ul>
        </div>
      ) : null}
      {setPerms.isError ? <div className={styles.error}>{(setPerms.error as Error).message}</div> : null}
      {notice ? <div className={styles.permMsg}>{notice}</div> : null}
      <div className={styles.permList}>
        {tools.map((t) => (
          <ToolRow
            key={t.name}
            server={server.name}
            tool={t}
            view={view}
            disabled={disabled}
            onChoose={(tool, choice) => apply([{ tool, kind: choice === "default" ? null : choice }])}
          />
        ))}
      </div>
    </div>
  );
}
