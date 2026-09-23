// The scope model of the extensions panels (Global → This repository → This conversation),
// and the expanded tool list of a Claude MCP server with a permission per tool. The
// cascade itself — and why Flight Deck resolves it instead of Claude Code's files — is in
// mcpToolPermissions.ts; the storage and delivery to sessions in store/mcpPolicy.ts.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import type { McpServerLive, McpToolInfo, PermissionRule, PluginInfo, ToolRuleKind } from "../../ipc/client";
import { Toggle } from "../../ui/Toggle";
import { useMcpPermissionRules } from "../../ipc/useExtensions";
import { applyPolicyChange, cascadeOf, useMcpPolicy, type PolicyChanges } from "../../store/mcpPolicy";
import {
  TOOL_CHOICES,
  describeFrom,
  describeRule,
  mcpToolRuleName,
  nativeResolve,
  pluginAt,
  pluginWrite,
  readOnlyPreset,
  resetServer,
  serverAt,
  serverInherited,
  serverRuleName,
  serverSummary,
  setAll,
  toolNature,
  toolRowState,
  type Cascade,
  type PermissionScope,
  type PluginFileSay,
  type ToolChange,
  type ToolChoice,
  type ToolRowState,
} from "./mcpToolPermissions";
import styles from "./ExtensionsManager.module.css";

const CHOICE_LABEL: Record<ToolChoice, string> = { default: "Default", allow: "Allow", ask: "Ask", deny: "Block" };
const KIND_LABEL: Record<ToolRuleKind, string> = { allow: "Allow", ask: "Ask", deny: "Block" };

export const SCOPE_LABEL: Record<PermissionScope, string> = {
  conversation: "This conversation",
  repository: "This repository",
  global: "Global",
};

/** Everything a panel needs to show and change one scope. */
export interface PermissionTarget {
  scope: PermissionScope;
  /** Flight Deck's levels that apply here (the scope and the broader ones). */
  cascade: Cascade;
  /** Claude Code's own rules from its settings files (undefined while loading). */
  external: PermissionRule[] | undefined;
  loadError: string | null;
  /** Settings files that couldn't be read — a rule in them may apply unseen. */
  warnings: string[];
  /** Claude Code's files' say on a plugin. */
  pluginFiles: (pluginId: string) => PluginFileSay[];
  /** Why this scope can't be changed here (null: it can). */
  readOnlyReason: string | null;
  applyTools: (changes: ToolChange[]) => void;
  /** A server on/off at this scope (null: drop the scope's say). */
  setServer: (server: string, on: boolean | null) => void;
  /** A plugin on/off at this scope (null: drop the scope's say). Resolves once saved. */
  setPlugin: (pluginId: string, enabled: boolean | null) => Promise<unknown>;
  pending: boolean;
  error: string | null;
  /** What this scope reaches, in one line. */
  hint: string;
}

const HINT: Record<PermissionScope, string> = {
  conversation:
    "Changes apply to this conversation only. It starts from the repository and Global settings, and can loosen them as well as tighten them.",
  repository:
    "Changes apply to every conversation of this repository (its worktrees too). They start from Global, and can loosen it as well as tighten it.",
  global:
    "Changes apply to every conversation, unless a repository or a conversation sets otherwise. Only what exists globally is listed here.",
};

/**
 * One scope's view and writer. `repoPath` = where Claude Code's files are read for (null
 * on the conversation-less Settings page); `repoId`/`convId` = the app's repository and
 * conversation the Repository / Conversation levels belong to.
 */
export function useExtensionScope(
  scope: PermissionScope,
  repoPath: string | null,
  repoId: string | null,
  convId: string | null,
): PermissionTarget {
  const qc = useQueryClient();
  const files = useMcpPermissionRules(repoPath);
  const policy = useMcpPolicy();
  const key = scope === "repository" ? repoId : scope === "conversation" ? convId : null;
  const write = useMutation({
    mutationFn: async (changes: PolicyChanges) => {
      // The Global plugin state is Claude Code's own (`enabledPlugins`, user settings).
      if (scope === "global" && changes.plugins?.length) {
        for (const p of changes.plugins) {
          const res = await commands.setPluginEnabled(p.id, p.enabled ?? false);
          if (res.status === "error") throw new Error(res.error);
        }
        return;
      }
      await applyPolicyChange({ scope, key }, changes);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["mcp-permission-rules"] });
      void qc.invalidateQueries({ queryKey: ["extensions"] });
    },
  });
  const view = files.data;
  return {
    scope,
    cascade: cascadeOf(policy, repoId, convId),
    external: view?.rules,
    loadError: files.isError ? (files.error as Error).message : null,
    warnings: view?.warnings ?? [],
    pluginFiles: (pluginId) =>
      (view?.plugins ?? []).filter((p) => p.plugin_id === pluginId).map((p) => ({ source: p.source, enabled: p.enabled })),
    readOnlyReason:
      scope !== "global" && !key
        ? scope === "repository"
          ? "This conversation doesn't belong to a repository."
          : "No conversation to apply this to."
        : null,
    applyTools: (tools) => write.mutate({ tools }),
    setServer: (server, on) => write.mutate({ servers: [{ server, on }] }),
    setPlugin: (id, enabled) => write.mutateAsync({ plugins: [{ id, enabled }] }),
    pending: write.isPending,
    error: write.isError ? (write.error as Error).message : null,
    hint: HINT[scope],
  };
}

/** The scope picker at the top of a panel: where the changes below apply. */
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
      <div className={styles.scopeHint}>{hint}</div>
    </div>
  );
}

const SCOPE_WHERE: Record<PermissionScope, string> = {
  conversation: "this conversation",
  repository: "this repository",
  global: "every conversation",
};

/** A server's on/off at a scope. Off in Claude Code's own files can't be undone here. */
export function ServerScopeToggle({ server, target, busy }: { server: McpServerLive; target: PermissionTarget; busy?: boolean }) {
  const st = serverAt(target.cascade, target.scope, server.name);
  // A Claude Code rule turning EVERY tool of the server off (the server rule, or a glob).
  const ext = target.external ? nativeResolve(`${serverRuleName(server.name)}__\u0001`, target.external) : null;
  const externalOff = ext?.kind === "deny" ? ext : null;
  const on = st.on && !externalOff;
  const reason = externalOff
    ? `Turned off by ${describeRule(externalOff)} — Claude Code enforces it on its own.`
    : target.readOnlyReason;
  const title =
    reason ??
    (st.own === null && st.from
      ? `${on ? "On" : "Off"} from ${st.from === "global" ? "Global" : SCOPE_WHERE[st.from]} — switching it here overrides that for ${SCOPE_WHERE[target.scope]}.`
      : `${on ? "Turn off" : "Turn on"} for ${SCOPE_WHERE[target.scope]} — its tools leave (or rejoin) Claude's context.`);
  return (
    <Toggle
      checked={on}
      disabled={!!busy || target.pending || reason != null}
      onChange={(next) =>
        target.setServer(server.name, next === serverInherited(target.cascade, target.scope, server.name) ? null : next)
      }
      label={`${on ? "Turn off" : "Turn on"} ${server.name}`}
      title={title}
    />
  );
}

/** A plugin as one scope sees it: the toggle's state, a note, and what flipping it writes. */
export function pluginAtScope(plugin: PluginInfo, target: PermissionTarget) {
  const st = pluginAt(target.cascade, target.scope, plugin.id, target.pluginFiles(plugin.id), plugin.enabled);
  return {
    enabled: st.enabled,
    note:
      target.scope !== "global" && st.own
        ? `Set for ${SCOPE_WHERE[target.scope]} (${st.inherited ? "on" : "off"} otherwise)`
        : null,
    locked: st.lockedByPolicy ? "Your organization's policy decides this plugin." : target.readOnlyReason,
    title:
      target.scope === "global"
        ? "On/off for every conversation (Claude Code's own setting, ~/.claude/settings.json)"
        : `On/off for ${SCOPE_WHERE[target.scope]}`,
    write: (next: boolean) => pluginWrite(st, next, target.scope),
  };
}

/** The server's tools with their metadata; plain names when the session gave none. */
export function toolsOf(server: McpServerLive): McpToolInfo[] {
  return server.tool_info?.length
    ? server.tool_info
    : server.tools.map((name) => ({ name, description: null, read_only: null, destructive: null }));
}

/** "Block 2 · Ask 3" — what a server's tools get at this scope, for its collapsed row. */
export function McpPermissionSummary({ server, target }: { server: McpServerLive; target: PermissionTarget }) {
  const s = serverSummary(target.cascade, target.scope, server.name, toolsOf(server));
  const parts = (["deny", "ask", "allow"] as const).filter((k) => s[k] > 0).map((k) => `${KIND_LABEL[k]} ${s[k]}`);
  if (!parts.length) return null;
  return (
    <span className={styles.permSummary} title="Tools of this server with a setting at this scope (its own or inherited)">
      {parts.join(" · ")}
    </span>
  );
}

function choiceTitle(c: ToolChoice, s: ToolRowState, scope: PermissionScope): string {
  const blocked = s.blockedBy[c];
  if (c !== "default" && blocked) return `Not available: ${describeRule(blocked)} — Claude Code enforces it on its own.`;
  switch (c) {
    case "default":
      if (s.from && s.shown) return `Follow ${describeFrom(s.from)}: ${KIND_LABEL[s.shown]}.`;
      return scope === "global"
        ? "No setting — the conversation's permission mode decides. In Auto mode the classifier may run it without asking."
        : "Follow the broader settings — none says anything, so the permission mode decides.";
    case "allow":
      return `Runs without asking, for ${SCOPE_WHERE[scope]}.`;
    case "ask":
      return `Asks before every call — even in Auto and Bypass permissions modes — for ${SCOPE_WHERE[scope]}.`;
    case "deny":
      return `Hidden from Claude for ${SCOPE_WHERE[scope]}: it can't call this tool.`;
  }
}

function ToolRow({
  server,
  tool,
  target,
  disabled,
  onChoose,
}: {
  server: string;
  tool: McpToolInfo;
  target: PermissionTarget;
  disabled: boolean;
  onChoose: (rule: string, choice: ToolChoice) => void;
}) {
  const rule = mcpToolRuleName(server, tool.name);
  const s = toolRowState(target.cascade, target.scope, rule, target.external ?? []);
  const nature = toolNature(tool);
  // What the segmented control lights: the scope's own choice, else the inherited value.
  const lit: ToolChoice = s.choice !== "default" ? s.choice : "default";
  return (
    <div className={styles.permRow}>
      <div className={styles.permName}>
        <span className={styles.permTool} title={tool.description ?? rule}>
          {tool.name}
        </span>
        <span
          className={`${styles.permNature} ${nature.from === "name" ? styles.permNatureGuess : ""}`}
          title={nature.from === "annotation" ? "As declared by the server" : "Guessed from the tool's name — the server doesn't say"}
        >
          {nature.nature}
        </span>
      </div>
      <div className={styles.permSeg} role="radiogroup" aria-label={`Permission for ${tool.name}`}>
        {TOOL_CHOICES.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={lit === c}
            className={[
              styles.permOpt,
              lit === c ? styles.permOptOn : "",
              // The inherited value, lit faintly on its button while "Default" is picked.
              lit === "default" && c !== "default" && s.shown === c ? styles.permOptInherited : "",
              styles[`permOpt_${c}`] ?? "",
            ].join(" ")}
            disabled={disabled || (c !== "default" && s.blockedBy[c] != null)}
            title={choiceTitle(c, s, target.scope)}
            onClick={() => s.choice !== c && onChoose(rule, c)}
          >
            {CHOICE_LABEL[c]}
          </button>
        ))}
      </div>
      {s.overriddenBy ? (
        <div className={styles.permNote + " " + styles.permNoteWarn}>
          {KIND_LABEL[s.overriddenBy.kind]} applies anyway — {describeRule(s.overriddenBy)}
        </div>
      ) : s.choice === "default" && s.from && s.shown ? (
        <div className={styles.permNote}>
          → {KIND_LABEL[s.shown]} · from {describeFrom(s.from)}
        </div>
      ) : null}
    </div>
  );
}

export function McpToolPermissions({ server, target }: { server: McpServerLive; target: PermissionTarget }) {
  const tools = toolsOf(server);
  const [notice, setNotice] = useState<string | null>(null);
  if (target.loadError) {
    return <div className={styles.error}>Unable to read Claude Code's settings files: {target.loadError}</div>;
  }
  if (!target.external) return <div className={styles.permMsg}>Reading permission rules…</div>;
  const { cascade, scope } = target;
  const disabled = target.readOnlyReason != null || target.pending;
  const run = (changes: ToolChange[]) => {
    setNotice(changes.length ? null : "Nothing to change.");
    if (changes.length) target.applyTools(changes);
  };
  const resetChanges = resetServer(cascade, scope, server.name, tools);
  return (
    <div className={styles.permPanel}>
      <div className={styles.permBar}>
        <button
          className={styles.actBtn}
          disabled={disabled}
          onClick={() => run(readOnlyPreset(cascade, scope, server.name, tools))}
          title="Allow the tools that only read; every other tool asks before running."
        >
          Read-only
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => run(setAll(cascade, scope, server.name, tools, "allow"))} title="Allow every tool of this server.">
          Allow all
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => run(setAll(cascade, scope, server.name, tools, "ask"))} title="Ask before every call to this server.">
          Ask for all
        </button>
        <button className={styles.actBtn} disabled={disabled} onClick={() => run(setAll(cascade, scope, server.name, tools, "deny"))} title="Hide every tool of this server from Claude.">
          Block all
        </button>
        <button
          className={styles.actBtn}
          disabled={disabled || resetChanges.length === 0}
          onClick={() => run(resetChanges)}
          title={`Remove what is set here for this server's tools — they follow the broader settings again.`}
        >
          Reset
        </button>
      </div>
      {target.readOnlyReason ? <div className={styles.error}>{target.readOnlyReason}</div> : null}
      {target.warnings.length ? (
        <div className={styles.warn}>
          Some of Claude Code's settings files couldn't be read — a rule in them may apply without showing here:
          <ul>
            {target.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {notice ? <div className={styles.permMsg}>{notice}</div> : null}
      <div className={styles.permList}>
        {tools.map((t) => (
          <ToolRow
            key={t.name}
            server={server.name}
            tool={t}
            target={target}
            disabled={disabled}
            onChoose={(tool, choice) => {
              setNotice(null);
              target.applyTools([{ tool, kind: choice === "default" ? null : choice }]);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Claude Code's own MCP rules (its settings files). They apply underneath Flight Deck —
 * Claude enforces them itself, deny > ask > allow — so a deny/ask there can't be loosened
 * from here. Listed where they matter; one in the user file can be removed.
 */
export function ExternalRules({ target }: { target: PermissionTarget }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: async (rule: string) => {
      const res = await commands.setMcpToolPermissions([{ tool: rule, kind: null }]);
      if (res.status === "error") throw new Error(res.error);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["mcp-permission-rules"] }),
  });
  const rules = (target.external ?? []).filter((r) => r.kind !== "allow");
  if (!rules.length) return null;
  const removable = (r: PermissionRule) => r.source === "user" && r.rule.startsWith("mcp__") && !r.rule.includes("*");
  return (
    <div className={styles.warn}>
      Claude Code's own settings also restrict MCP tools — it enforces these itself, so they apply whatever is set here:
      <ul>
        {rules.map((r) => (
          <li key={`${r.source}:${r.kind}:${r.rule}`}>
            {KIND_LABEL[r.kind]} · {describeRule(r)}
            {removable(r) ? (
              <button
                className={styles.linkBtn}
                disabled={remove.isPending}
                onClick={() => remove.mutate(r.rule)}
                title="Remove this rule from ~/.claude/settings.json"
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {remove.isError ? <div className={styles.error}>{(remove.error as Error).message}</div> : null}
    </div>
  );
}
