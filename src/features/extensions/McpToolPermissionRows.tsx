// The scope model of the extensions panels, and the expanded tool list of a Claude MCP
// server with a permission per tool (Default / Allow / Ask / Block — Claude Code's own
// permission rules). Three scopes (see mcpToolPermissions.ts):
//   • conversation — that conversation's session layer, it alone (the ⌘E default);
//   • repository — the repository's .claude/settings.local.json, on this machine;
//   • global — ~/.claude/settings.json, every conversation (Settings → Extensions).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import type { McpServerLive, McpToolInfo, PluginInfo, ToolRuleKind } from "../../ipc/client";
import { Toggle } from "../../ui/Toggle";
import { useMcpPermissionRules } from "../../ipc/useExtensions";
import {
  applyConvOverrides,
  convPluginSay,
  convToolRules,
  useConvToolPermissions,
  type PluginChange,
} from "../../store/convToolPermissions";
import {
  TOOL_CHOICES,
  describeRule,
  describeSource,
  mcpToolRuleName,
  pluginScopeState,
  pluginWrite,
  readOnlyPreset,
  resetServer,
  serverOffState,
  serverRuleName,
  serverSummary,
  setAll,
  toolNature,
  toolPermissionState,
  type PermissionScope,
  type PluginSay,
  type ToolChange,
  type ToolChoice,
  type ToolPermissionState,
  type ToolRule,
} from "./mcpToolPermissions";
import styles from "./ExtensionsManager.module.css";

const CHOICE_LABEL: Record<ToolChoice, string> = { default: "Default", allow: "Allow", ask: "Ask", deny: "Block" };
const KIND_LABEL: Record<ToolRuleKind, string> = { allow: "Allow", ask: "Ask", deny: "Block" };

/** Everything a panel needs to show and change one scope's settings. */
export interface PermissionTarget {
  scope: PermissionScope;
  /** Every rule that applies (files + the conversation's own); undefined while loading. */
  rules: ToolRule[] | undefined;
  loadError: string | null;
  /** Settings files that couldn't be read — a rule in them may apply unseen. */
  warnings: string[];
  /** Why this scope can't be changed right now (null: it can). */
  readOnlyReason: string | null;
  /** Change MCP rules (per tool, or a whole server) at this scope. */
  apply: (changes: ToolChange[]) => void;
  /** Every source's say on a plugin (files + the conversation's own). */
  pluginSays: (pluginId: string) => PluginSay[];
  /** Turn a plugin on/off at this scope (null: drop this scope's say). Resolves once
   *  written — the caller may offer to reload the live conversations. */
  setPlugin: (pluginId: string, enabled: boolean | null) => Promise<unknown>;
  pending: boolean;
  error: string | null;
  /** What this scope reaches, in one line. */
  hint: string;
}

export const SCOPE_LABEL: Record<PermissionScope, string> = {
  conversation: "This conversation",
  repository: "This repository",
  global: "Global",
};

const repoName = (root: string | null | undefined) => (root ? root.split("/").filter(Boolean).pop() : null);

function scopeHint(scope: PermissionScope, repoRoot: string | null | undefined): string {
  switch (scope) {
    case "conversation":
      return "Changes apply to this conversation only.";
    case "repository":
      return `Changes apply to every conversation in ${repoName(repoRoot) ?? "this repository"}, on this machine — saved in .claude/settings.local.json, never committed.`;
    case "global":
      return "Changes apply to every conversation, and to Claude Code in your terminal — saved in ~/.claude/settings.json.";
  }
}

/**
 * One scope's view and writer. `repoPath` = the repository the files are read for (null on
 * the conversation-less Settings page); `convId`/`handle` = the conversation whose own
 * settings apply (null outside one).
 */
export function useExtensionScope(
  scope: PermissionScope,
  repoPath: string | null,
  convId: string | null,
  handle: string | null,
): PermissionTarget {
  const qc = useQueryClient();
  const files = useMcpPermissionRules(repoPath);
  const byConv = useConvToolPermissions((s) => s.byConv);
  const write = useMutation({
    mutationFn: async ({ rules, plugins }: { rules: ToolChange[]; plugins: PluginChange[] }) => {
      if (scope === "conversation") {
        if (!convId) throw new Error("No conversation to apply this to.");
        return applyConvOverrides(convId, handle, rules, plugins);
      }
      const target = scope === "repository" ? "repository" : "global";
      const repo = scope === "repository" ? repoPath : null;
      if (rules.length) {
        const res = await commands.setMcpToolPermissions(rules, target, repo);
        if (res.status === "error") throw new Error(res.error);
      }
      for (const p of plugins) {
        const res = await commands.setPluginOverride(p.id, p.enabled, target, repo);
        if (res.status === "error") throw new Error(res.error);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["mcp-permission-rules"] });
      void qc.invalidateQueries({ queryKey: ["extensions"] });
    },
  });
  const view = files.data;
  const fileError = scope === "global" ? view?.user_error : scope === "repository" ? view?.local_error : null;
  return {
    scope,
    rules: view ? [...view.rules, ...(convId ? convToolRules(byConv, convId) : [])] : undefined,
    loadError: files.isError ? (files.error as Error).message : null,
    warnings: (view?.warnings ?? []).filter((w) => w !== fileError),
    readOnlyReason:
      scope === "repository" && !repoPath
        ? "No repository to save this in."
        : fileError
          ? `This scope's settings file can't be read, so it can't be changed from here: ${fileError}`
          : null,
    apply: (changes) => write.mutate({ rules: changes, plugins: [] }),
    pluginSays: (pluginId) => [
      ...(view?.plugins ?? [])
        .filter((p) => p.plugin_id === pluginId)
        .map((p) => ({ source: p.source, enabled: p.enabled })),
      ...(convId ? convPluginSay(byConv, convId, pluginId) : []),
    ],
    setPlugin: (pluginId, enabled) => write.mutateAsync({ rules: [], plugins: [{ id: pluginId, enabled }] }),
    pending: write.isPending,
    error: write.isError ? (write.error as Error).message : null,
    hint: scopeHint(scope, view?.repo_root ?? repoPath),
  };
}

const SCOPE_WHERE: Record<PermissionScope, string> = {
  conversation: "this conversation",
  repository: "every conversation in this repository",
  global: "every conversation",
};

/** The scope picker at the top of a panel: where the changes below will apply. */
export function ScopeSwitcher({
  scope,
  onChange,
  hint,
}: {
  scope: PermissionScope;
  onChange: (s: PermissionScope) => void;
  hint: string;
}) {
  return (
    <div className={styles.scopeBar}>
      <div className={styles.scopeHead}>
        <span className={styles.scopeLabel}>Apply changes to</span>
        <div className={styles.scopeSeg} role="tablist" aria-label="Where changes apply">
          {(["conversation", "repository", "global"] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              className={`${styles.scopeOpt} ${scope === s ? styles.scopeOptOn : ""}`}
              onClick={() => onChange(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.scopeHint}>{hint} Skills and sub-agents are listed as-is; their badge says where they come from.</div>
    </div>
  );
}

/** A server's on/off at a scope: a `deny` on the whole server in that scope's settings.
 *  Off from a broader source (or the org) can't be turned back on here — it says why. */
export function ServerScopeToggle({ server, perms, busy }: { server: McpServerLive; perms: PermissionTarget; busy?: boolean }) {
  const st = perms.rules ? serverOffState(server.name, perms.rules, perms.scope) : null;
  const on = !(st?.off ?? false);
  const reason = st?.offBy
    ? `Turned off by ${describeRule(st.offBy)} — it can't be turned back on from here.`
    : perms.readOnlyReason;
  return (
    <Toggle
      checked={on}
      disabled={!st || !!busy || perms.pending || reason != null}
      onChange={(next) => perms.apply([{ tool: serverRuleName(server.name), kind: next ? null : "deny" }])}
      label={`${on ? "Turn off" : "Turn on"} ${server.name}`}
      title={reason ?? `${on ? "Turn off" : "Turn on"} for ${SCOPE_WHERE[perms.scope]} — its tools leave (or rejoin) Claude's context`}
    />
  );
}

/** A plugin as one scope sees it: the toggle's state, what flipping it writes, and a note
 *  when a level above decides differently for this conversation. */
export function pluginAtScope(plugin: PluginInfo, perms: PermissionTarget) {
  const st = pluginScopeState(perms.pluginSays(plugin.id), perms.scope, plugin.enabled);
  const note = st.overriddenBy
    ? `${st.effective ? "On" : "Off"} for this conversation — ${describeSource(st.overriddenBy)} decide${st.overriddenBy === "conversation" ? "" : "s"}`
    : null;
  return {
    enabled: st.enabled,
    note,
    locked: st.lockedByPolicy
      ? "Your organization's policy decides this plugin."
      : perms.readOnlyReason,
    title: `On/off for ${SCOPE_WHERE[perms.scope]}`,
    /** What to write for `next` (null = drop this scope's say, follow the levels below). */
    write: (next: boolean) => pluginWrite(st, next, perms.scope),
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
      return scope === "global"
        ? "No rule — the conversation's permission mode decides. In Auto mode the classifier may run it without asking."
        : "No rule here — the broader settings apply, and without one the permission mode decides.";
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
