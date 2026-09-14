// Settings → Claude Code. One page, three sections, one mental model: which model each
// helper runs on, what they cost, and the instructions that let Claude choose well.
//
// The tab only exists when a Claude account is connected (see SettingsPanel) — everything
// here is Claude-specific down to the model names, so there is nothing to show otherwise.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "../../../ipc/client";
import type { AgentRouting, Result, SpendBucket } from "../../../ipc/bindings";
import { useActiveConversationId, useConversationRepo } from "../../../store/conversationsStore";
import { useRateCard, useSubagentPricing } from "../../../store/subagentPricing";
import { CLAUDE_MODELS } from "../../conversation/models";
import { effortLevelsForModel } from "../../conversation/EffortGauge";
import { EFFORT_LABELS } from "../../../agent/subagentMeta";
import { Ico } from "../../../ui/kit";
import { ConfirmDialog } from "../../../ui/ConfirmDialog";
import { PageHead, SettingsGroup } from "../SettingsKit";
import { StackedBarsOverTime, StackedBarChart, hueForSeries } from "./Charts";
import { copyFor, INSTRUCTION_BLOCKS } from "./agentCopy";
import { countChanges, diffLines, withElisions } from "./lineDiff";
import {
  applyFilter,
  dailyByModel,
  dayCutoff,
  formatCost,
  formatTokens,
  groupSpend,
  findDrift,
  labelForTranscriptModel,
  modelsByRepo,
  pricingKeyForTranscriptModel,
  unpricedKeys,
  type SpendFilter,
} from "./spend";
import "./claude-code-section.css";

/** Same tiny helper the other IPC hooks keep locally: a `Result` becomes a resolved value
 *  or a rejected promise, so TanStack Query surfaces the error. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export function ClaudeCodeSection() {
  const convId = useActiveConversationId();
  const repo = useConversationRepo(convId);
  const repoPath = repo?.path ?? null;

  return (
    <div>
      <PageHead
        title="Claude Code"
        subtitle="Which model each helper runs on, what they cost, and the instructions Claude works from."
      />
      <RoutingGroup repoPath={repoPath} />
      <SpendGroup repoPath={repoPath} />
      <InstructionsGroup />
    </div>
  );
}

// ---- A. Routing ------------------------------------------------------------

const routingKey = (path: string | null) => ["subagent-routing", path] as const;
const spendKey = ["subagent-spend"] as const;
const memoryKey = ["claude-memory"] as const;

function RoutingGroup({ repoPath }: { repoPath: string | null }) {
  const qc = useQueryClient();
  const routing = useQuery({
    queryKey: routingKey(repoPath),
    enabled: !!repoPath,
    queryFn: () => unwrap(commands.listSubagentRouting(repoPath!)),
    staleTime: 5_000,
  });
  const spend = useQuery({
    queryKey: spendKey,
    queryFn: () => unwrap(commands.subagentSpend()),
    staleTime: 60_000,
  });
  const setBaseline = useMutation({
    mutationFn: (v: { model: string | null; forced: string | null }) =>
      unwrap(commands.setSubagentBaseline(v.model, v.forced)),
    onSettled: () => qc.invalidateQueries({ queryKey: routingKey(repoPath) }),
  });
  const setModel = useMutation({
    mutationFn: (v: { path: string; model: string | null; effort: string | null }) =>
      unwrap(commands.setSubagentModel(v.path, v.model, v.effort)),
    onSettled: () => qc.invalidateQueries({ queryKey: routingKey(repoPath) }),
  });

  const agents = routing.data?.agents ?? [];
  const baseline = routing.data?.baseline;
  const forced = baseline?.forced_model ?? null;
  // settings.json exists but could not be read: the baseline and the lock are UNKNOWN, so
  // offering to change them would write over a file we never understood.
  const baselineError = baseline?.error ?? null;

  // The behaviour canary: what the transcripts say these agents actually ran on, over the
  // last week, versus what they are configured for.
  const drift = useMemo(() => {
    if (!spend.data || agents.length === 0) return [];
    const recent = applyFilter(spend.data.buckets, {
      since: dayCutoff(7),
      repo: null,
      includeWorkflow: true,
    });
    return findDrift(
      recent,
      agents.map((a: AgentRouting) => ({
        name: a.name,
        model: a.effective_model,
        configuredAtMs: a.configured_at_ms,
        overriddenByForce: a.overridden_by_force,
      })),
    );
  }, [spend.data, agents]);

  if (!repoPath) {
    return (
      <SettingsGroup icon="bot" title="Helpers">
        <p className="cc-hint cc-pad">Open a conversation to see the helpers for its folder.</p>
      </SettingsGroup>
    );
  }

  return (
    <>
      {drift.length > 0 && (
        <div className="cc-alert" role="status">
          <Ico name="alert" />
          <div>
            <b>
              {/* The helper's business name, not its dispatch name: the row below is
                  called "Code search", and a banner that says "Explore" sends the reader
                  looking for a setting that is not on the page. */}
              {copyFor(drift[0]!.agent, null).title} recently ran on{" "}
              {drift[0]!.observedLabel} while its setting says {drift[0]!.configuredLabel}
            </b>
            {/* An observation, not an accusation: a model passed when the helper is started
                outranks its setting BY DESIGN — and this app's own routing instructions
                ask Claude to pass one. Claiming the setting "is not taking effect" would be
                wrong in exactly the case the app encourages. */}
            <p>
              {drift[0]!.turns} turn{drift[0]!.turns === 1 ? "" : "s"}{" "}
              {drift[0]!.since
                ? `since this last changed on ${drift[0]!.since}`
                : "in the last 7 days"}
              . A model passed when the helper is started — by Claude or by a workflow —
              overrides this setting, so this can be expected. If nothing should be passing
              one, the name this setting hangs on may have changed in the Claude CLI.
            </p>
          </div>
        </div>
      )}

      <SettingsGroup icon="bot" title="Baseline">
        <div className="cc-baseline cc-pad">
          <p className="cc-lede">
            The model helpers fall back to when nothing closer to the task says otherwise.
          </p>
          {baselineError && (
            <p className="cc-error">
              <Ico name="alert" /> Could not read your Claude settings ({baselineError}), so the
              baseline and the budget lock below are unknown. Fix the file by hand and reopen
              this page — nothing will be written until then.
            </p>
          )}
          <ModelPicker
            value={baseline?.model ?? null}
            // While the budget is locked the lock FOLLOWS the baseline: re-sending the old
            // forced value kept every helper on the previous model while this picker showed
            // the new one. Clearing the baseline clears the lock with it — a lock with no
            // baseline has nothing on the page to point at.
            onChange={(m) => setBaseline.mutate({ model: m, forced: forced ? m : null })}
            inheritLabel="No baseline — helpers follow the conversation"
            disabled={setBaseline.isPending || !!baselineError}
          />
          <p className="cc-hint">
            Does not reach <b>Code search</b> or <b>Planning</b>: those two keep following the
            conversation unless they have a setting of their own below.
          </p>
          <ForceToggle
            forced={forced}
            baselineModel={baseline?.model ?? null}
            onChange={(f) => setBaseline.mutate({ model: baseline?.model ?? null, forced: f })}
            busy={setBaseline.isPending || !!baselineError}
          />
          {setBaseline.error && (
            <p className="cc-error">Could not save the baseline: {String(setBaseline.error)}</p>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup icon="spark" title="Each helper">
        {routing.isLoading && <p className="cc-hint cc-pad">Reading your helper definitions…</p>}
        {routing.error && (
          <p className="cc-error cc-pad">Could not read the helpers: {String(routing.error)}</p>
        )}
        {setModel.error && (
          <p className="cc-error cc-pad">
            Could not save the helper's setting: {String(setModel.error)}
          </p>
        )}
        {agents.map((agent: AgentRouting) => (
          <AgentRow
            key={`${agent.name}:${agent.path ?? "builtin"}`}
            agent={agent}
            forced={forced}
            // Pending covers the write AND the refetch (onSettled returns the invalidation
            // promise). A second edit before the fresh row lands would be built from the
            // stale one and revert the first.
            busy={setModel.isPending && setModel.variables?.path === agent.path}
            spend={spend.data?.buckets ?? []}
            onSetModel={(model, effort) =>
              agent.path
                ? setModel.mutate({ path: agent.path, model, effort })
                : undefined
            }
            userAgentsDir={routing.data?.user_agents_dir ?? ""}
            onCreated={() => qc.invalidateQueries({ queryKey: routingKey(repoPath) })}
          />
        ))}
        {routing.data?.project_dir_ignored && (
          <p className="cc-warn cc-warn-inset">
            <Ico name="alert" /> This folder's git setup ignores <code>.claude/</code>, so a
            setting saved just for this project would not follow you into a worktree or reach
            anyone else. Everything here is saved for all your projects instead.
          </p>
        )}
        {routing.data?.repo_is_worktree && (
          <p className="cc-warn cc-warn-inset">
            <Ico name="alert" /> You are in a worktree. Project-only settings written here
            disappear with it.
          </p>
        )}
      </SettingsGroup>
    </>
  );
}

function ForceToggle({
  forced,
  baselineModel,
  onChange,
  busy,
}: {
  forced: string | null;
  baselineModel: string | null;
  onChange: (forced: string | null) => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <label className="cc-force">
        <input
          type="checkbox"
          checked={!!forced}
          disabled={busy || (!forced && !baselineModel)}
          onChange={(e) => (e.target.checked ? setConfirming(true) : onChange(null))}
        />
        <span>
          <b>Lock the budget</b>
          <em>
            Force the baseline on every helper, overriding each setting below and any model a
            workflow asks for.
          </em>
          {/* What settings.json ACTUALLY forces, read back from disk — not what the picker
              above assumes. A lock left on an older model (by a hand edit, or by a previous
              version of this page) must be visible, not hidden behind the new baseline. */}
          {forced && (
            <em>
              Locked to <b className="cc-inline-b">{labelForTranscriptModel(forced)}</b>
              {forced !== baselineModel &&
                " — not the baseline above. Choose the baseline again to move the lock with it."}
            </em>
          )}
        </span>
      </label>
      <ConfirmDialog
        open={confirming}
        title="Force one model on every helper?"
        confirmLabel="Force it"
        danger
        onConfirm={() => {
          onChange(baselineModel);
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Every per-helper choice below stops applying, and so does any model a workflow picks
          for its workers — including the ones you want to stay strong.
        </p>
        <p>This is a blunt cost cap, not fine-tuning. You can turn it off at any time.</p>
      </ConfirmDialog>
    </>
  );
}

function AgentRow({
  agent,
  forced,
  busy,
  spend,
  onSetModel,
  userAgentsDir,
  onCreated,
}: {
  agent: AgentRouting;
  forced: string | null;
  busy: boolean;
  spend: SpendBucket[];
  onSetModel: (model: string | null, effort: string | null) => void;
  userAgentsDir: string;
  onCreated: () => void;
}) {
  const copy = copyFor(agent.name, agent.description);
  const [open, setOpen] = useState(false);
  const efforts = effortLevelsForModel(agent.effective_model);
  const recommended = copy.recommend;
  const offRecommendation =
    recommended && agent.effective_model && agent.effective_model !== recommended.model;
  // A plugin's definition lives in the plugin cache and is replaced wholesale on the next
  // plugin update — an edit here would look saved and then silently disappear.
  const pluginOwned = agent.origin === "plugin";
  const locked = !!forced || pluginOwned || busy;

  const usage = useMemo(() => {
    const recent = spend.filter((b) => b.agent === agent.name && b.day >= dayCutoff(7));
    const turns = recent.reduce((n, b) => n + b.turns, 0);
    const out = recent.reduce((n, b) => n + b.output_tokens, 0);
    return { turns, out };
  }, [spend, agent.name]);

  return (
    <div className="cc-agent" data-forced={forced ? "" : undefined}>
      <div className="cc-agent-head">
        <button
          type="button"
          className="cc-agent-name"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Ico name="chev" className={open ? "cc-chev cc-chev-open" : "cc-chev"} />
          {copy.title}
        </button>
        <Origin agent={agent} />
      </div>
      <p className="cc-agent-sum">{copy.summary}</p>

      {open && (
        <div className="cc-agent-detail">
          <p>
            <b>When Claude uses it.</b> {copy.whenUsed}
          </p>
          <p>
            <b>On a weaker model.</b> {copy.weaker}
          </p>
          <p>
            <b>On a stronger model.</b> {copy.stronger}
          </p>
          {agent.path && <p className="cc-path">{agent.path}</p>}
        </div>
      )}

      <div className="cc-agent-controls">
        {agent.path ? (
          <ModelPicker
            value={agent.effective_model}
            onChange={(m) => onSetModel(m, agent.effort)}
            inheritLabel="Follow the conversation"
            disabled={locked}
          />
        ) : (
          <TakeControl
            agent={agent}
            userAgentsDir={userAgentsDir}
            copy={copy}
            onCreated={onCreated}
          />
        )}
        {efforts.length > 0 && agent.path ? (
          <select
            className="cc-select cc-select-sm"
            value={agent.effort ?? ""}
            disabled={locked}
            // The file's OWN `model:`, not the effective one: that falls back to the
            // baseline, and writing it back would pin the baseline's model into the file.
            onChange={(e) => onSetModel(agent.defined_model, e.target.value || null)}
          >
            <option value="">Default depth</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABELS[level as keyof typeof EFFORT_LABELS] ?? level}
              </option>
            ))}
          </select>
        ) : (
          agent.path && <span className="cc-noeffort">No depth control on this model</span>
        )}
        {usage.turns > 0 && (
          <span className="cc-agent-usage">
            {usage.turns} turns · {formatTokens(usage.out)} out, last 7 days
          </span>
        )}
      </div>

      {recommended && (
        <p className={offRecommendation ? "cc-rec cc-rec-off" : "cc-rec"}>
          {offRecommendation && <Ico name="alert" />}
          Suggested: <b>{recommended.family}</b> — {recommended.because}
        </p>
      )}
      {pluginOwned && (
        <p className="cc-rec cc-rec-off">
          <Ico name="alert" /> Provided by a plugin — changes here would be overwritten when
          the plugin updates.
        </p>
      )}
      {forced && (
        <p className="cc-rec cc-rec-off">
          <Ico name="alert" /> Runs on <b>{labelForTranscriptModel(forced)}</b> while the
          budget is locked.
        </p>
      )}
    </div>
  );
}

function Origin({ agent }: { agent: AgentRouting }) {
  const text =
    agent.origin === "built_in"
      ? agent.needs_file_to_steer
        ? "Built in — needs its own file to steer"
        : "Built in — follows the baseline"
      : agent.origin === "plugin"
        ? "From a plugin"
        : agent.origin === "project"
          ? "Set for this project"
          : agent.origin === "local"
            ? "Set for this project, not shared"
            : "Set by you";
  return (
    <span className="cc-origin" title={agent.path ?? undefined}>
      {text}
      {agent.shadows_built_in && " · replaces the built-in"}
    </span>
  );
}

/**
 * Creating a definition file for a built-in.
 *
 * ⚠️ Deliberately NOT one click. A file named after a built-in replaces that agent
 * ENTIRELY — its instructions become whatever this file says, because the body of an agent
 * definition IS its system prompt. We cannot copy Anthropic's version (it is compiled into
 * the binary, not on disk), so the honest flow is to show the text that will be used and
 * let the user edit it before anything is written.
 */
function TakeControl({
  agent,
  userAgentsDir,
  copy,
  onCreated,
}: {
  agent: AgentRouting;
  userAgentsDir: string;
  copy: ReturnType<typeof copyFor>;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(copy.recommend?.model ?? "haiku");
  const [body, setBody] = useState(
    `${copy.summary}\n\n${copy.whenUsed}\n\nWork carefully and report what you found or did. Do not go beyond what you were asked.`,
  );
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        commands.createSubagentDefinition(
          userAgentsDir,
          agent.name,
          copy.summary,
          model,
          null,
          body,
        ),
      ),
    onSuccess: () => {
      setOpen(false);
      onCreated();
    },
  });

  return (
    <>
      <button type="button" className="cc-btn" onClick={() => setOpen(true)}>
        Give it its own model
      </button>
      <ConfirmDialog
        open={open}
        title={`Take control of ${copy.title}`}
        busy={create.isPending}
        confirmLabel="Write the file"
        onConfirm={() => create.mutate()}
        onCancel={() => setOpen(false)}
      >
        <div className="cc-take">
            <p>
              Claude Code has no way to change just the model of a built-in helper. Setting one
              means <b>replacing the helper</b> — these instructions become what it works from.
            </p>
            <label className="cc-field">
              Model
              <ModelPicker value={model} onChange={(m) => setModel(m ?? "haiku")} />
            </label>
            <label className="cc-field">
              Instructions
              <textarea
                className="cc-textarea"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <p className="cc-path">Will be written to {userAgentsDir}/{agent.name}.md</p>
          {create.error && <p className="cc-error">{String(create.error)}</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}

function ModelPicker({
  value,
  onChange,
  inheritLabel,
  disabled,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  inheritLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="cc-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {CLAUDE_MODELS.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

// ---- B. Spend --------------------------------------------------------------

const WINDOWS: Array<{ label: string; days: number | null }> = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "All time", days: null },
];

function SpendGroup({ repoPath }: { repoPath: string | null }) {
  const spend = useQuery({
    queryKey: spendKey,
    queryFn: () => unwrap(commands.subagentSpend()),
    staleTime: 60_000,
  });
  const card = useRateCard();
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [repo, setRepo] = useState<string | null>(null);
  const [includeWorkflow, setIncludeWorkflow] = useState(true);
  const [groupBy, setGroupBy] = useState<"model" | "agent" | "repo">("model");
  const [editingPrices, setEditingPrices] = useState(false);

  const buckets = spend.data?.buckets ?? [];
  const filter: SpendFilter = {
    since: windowDays === null ? null : dayCutoff(windowDays),
    repo,
    includeWorkflow,
  };
  const filtered = useMemo(() => applyFilter(buckets, filter), [buckets, windowDays, repo, includeWorkflow]);

  const repos = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of buckets) seen.set(b.repo, b.repo_label);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [buckets]);

  const rows = useMemo(() => groupSpend(filtered, groupBy, card), [filtered, groupBy, card]);
  const total = rows.reduce((n, r) => n + (r.cost ?? 0), 0);
  const totalOutput = rows.reduce((n, r) => n + r.outputTokens, 0);
  const anyUnpriced = rows.some((r) => r.cost === null);
  const series = useMemo(() => dailyByModel(filtered, card, "output"), [filtered, card]);
  const byRepo = useMemo(() => modelsByRepo(filtered, card), [filtered, card]);
  const wfShare = useMemo(() => {
    const wf = filtered.filter((b) => b.workflow);
    const wfCost = wf.reduce((n, b) => n + (costOr0(b, card) ?? 0), 0);
    return total > 0 ? wfCost / total : 0;
  }, [filtered, card, total]);

  return (
    <SettingsGroup
      icon="gauge"
      title="What the helpers cost"
    >
      <div className="cc-pad">
      <p className="cc-lede">
        Read from the transcripts Claude Code already writes — nothing extra is recorded.
      </p>
      <p className="cc-disclaimer">
        <Ico name="ask" />
        These are <b>Anthropic API list prices</b>. On a Claude subscription none of this is
        billed — read the numbers as the relative weight of one model against another, not as
        an invoice.
        <button type="button" className="cc-linkbtn" onClick={() => setEditingPrices((v) => !v)}>
          {editingPrices ? "Done" : "Edit prices"}
        </button>
      </p>

      {editingPrices && <PriceEditor buckets={buckets} />}

      {spend.isLoading && <p className="cc-hint">Reading sub-agent transcripts…</p>}
      {spend.error && <p className="cc-error">Could not read the transcripts: {String(spend.error)}</p>}
      {/* Every way the scan can come back partial is said out loud: a missing projects
          directory must not pass for "no helper turns", and skipped lines must not pass
          for a smaller bill. */}
      {spend.data?.warnings.map((w) => (
        <p key={w} className="cc-warn">
          <Ico name="alert" /> Could not read the transcripts fully: {w}.
        </p>
      ))}
      {spend.data && spend.data.files_unreadable > 0 && (
        <p className="cc-warn">
          <Ico name="alert" /> {spend.data.files_unreadable} transcript
          {spend.data.files_unreadable === 1 ? " was" : "s were"} unreadable, so the totals below
          are lower than the real figure.
        </p>
      )}
      {spend.data && spend.data.lines_unparsed > 0 && (
        <p className="cc-warn">
          <Ico name="alert" /> {spend.data.lines_unparsed.toLocaleString("en-US")} helper turn
          {spend.data.lines_unparsed === 1 ? " was" : "s were"} written in a shape this version
          cannot read, so the totals below may be lower than the real figure.
        </p>
      )}

      <div className="cc-filters">
        <select
          className="cc-select cc-select-sm"
          value={windowDays === null ? "all" : String(windowDays)}
          onChange={(e) => setWindowDays(e.target.value === "all" ? null : Number(e.target.value))}
        >
          {WINDOWS.map((w) => (
            <option key={w.label} value={w.days === null ? "all" : String(w.days)}>
              {w.label}
            </option>
          ))}
        </select>
        <select
          className="cc-select cc-select-sm"
          value={repo ?? ""}
          onChange={(e) => setRepo(e.target.value || null)}
        >
          <option value="">All folders</option>
          {repos.map(([path, label]) => (
            <option key={path} value={path}>
              {label}
            </option>
          ))}
        </select>
        {repoPath && repos.some(([p]) => p === repoPath) && repo !== repoPath && (
          <button type="button" className="cc-linkbtn" onClick={() => setRepo(repoPath)}>
            This folder
          </button>
        )}
        <label className="cc-check">
          <input
            type="checkbox"
            checked={includeWorkflow}
            onChange={(e) => setIncludeWorkflow(e.target.checked)}
          />
          Include workflow runs
        </label>
      </div>

      {/* Tokens lead, money trails. A dollar figure in the first tile made a £200/month
          subscription read as a $4 000 bill — and the disclaimer underneath could not undo
          the impression the big number had already made. Volume is the honest headline;
          the estimate is context, so it sits last and says what it is not. */}
      <div className="cc-tiles">
        <Tile label="Output tokens" value={formatTokens(totalOutput)} />
        <Tile
          label="Turns"
          value={rows.reduce((n, r) => n + r.turns, 0).toLocaleString("en-US")}
        />
        <Tile label="In workflow runs" value={`${Math.round(wfShare * 100)}%`} />
        <Tile
          label="At API rates"
          value={anyUnpriced ? `${formatCost(total)}+` : formatCost(total)}
          note="not your bill"
        />
      </div>

      <StackedBarsOverTime
        title="Output tokens per day"
        days={series.days}
        series={series.series}
        formatValue={formatTokens}
      />

      <StackedBarChart
        title="Per folder, by model"
        rows={byRepo.map((r) => ({
          key: r.repo,
          label: r.label,
          // The absolute path, surfaced on hover — a faded label must never leave the
          // reader guessing which of two similarly-named folders a row is.
          detail: r.repo,
          total: r.total,
          parts: r.parts,
        }))}
        formatValue={formatCost}
      />

      <div className="cc-tablehead">
        <div className="cc-seg">
          {(["model", "agent", "repo"] as const).map((g) => (
            <button
              key={g}
              type="button"
              data-on={groupBy === g ? "" : undefined}
              onClick={() => setGroupBy(g)}
            >
              {g === "model" ? "By model" : g === "agent" ? "By helper" : "By folder"}
            </button>
          ))}
        </div>
      </div>
      <table className="cc-table">
        <thead>
          <tr>
            <th>{groupBy === "model" ? "Model" : groupBy === "agent" ? "Helper" : "Folder"}</th>
            <th className="cc-num">Turns</th>
            <th className="cc-num">Output</th>
            <th className="cc-num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {groupBy === "model" && (
                  <span
                    className="cc-swatch"
                    style={{ background: hueForSeries(r.key) }}
                    aria-hidden
                  />
                )}
                {r.label}
              </td>
              <td className="cc-num">{r.turns.toLocaleString("en-US")}</td>
              <td className="cc-num">{formatTokens(r.outputTokens)}</td>
              <td className="cc-num">{formatCost(r.cost)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="cc-hint">
                {spend.isLoading
                  ? "Reading…"
                  : spend.error ||
                      (spend.data &&
                        spend.data.files_scanned === 0 &&
                        (spend.data.warnings.length > 0 || spend.data.files_unreadable > 0))
                    ? "Nothing could be read — see the warning above."
                    : "No helper turns in this range."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </SettingsGroup>
  );
}

function costOr0(bucket: SpendBucket, card: ReturnType<typeof useRateCard>) {
  const rate = card.rates[pricingKeyForTranscriptModel(bucket.model)];
  if (!rate) return 0;
  return (
    (bucket.input_tokens / 1e6) * rate.input +
    (bucket.output_tokens / 1e6) * rate.output +
    (bucket.cache_read_tokens / 1e6) * rate.input * card.cache.read +
    (bucket.cache_creation_tokens / 1e6) * rate.input * card.cache.write
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="cc-tile">
      <span className="cc-tile-label">{label}</span>
      <b className="cc-tile-value">{value}</b>
      {note && <span className="cc-tile-note">{note}</span>}
    </div>
  );
}

function PriceEditor({ buckets }: { buckets: SpendBucket[] }) {
  const card = useRateCard();
  const setRate = useSubagentPricing((s) => s.setRate);
  const setCacheRatios = useSubagentPricing((s) => s.setCacheRatios);
  const resetAll = useSubagentPricing((s) => s.resetAll);
  const keys = Object.keys(card.rates).sort();
  // Models that actually ran but have no price. Without them in this table an unpriced
  // model could never be given one, and would stay a "—" in every total forever.
  const missing = unpricedKeys(buckets, card);
  return (
    <div className="cc-prices">
      <table className="cc-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="cc-num">Input $/M</th>
            <th className="cc-num">Output $/M</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key}>
              <td>{labelForTranscriptModel(key)}</td>
              <td className="cc-num">
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  className="cc-numinput"
                  value={card.rates[key]!.input}
                  onChange={(e) =>
                    setRate(key, { ...card.rates[key]!, input: Number(e.target.value) })
                  }
                />
              </td>
              <td className="cc-num">
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  className="cc-numinput"
                  value={card.rates[key]!.output}
                  onChange={(e) =>
                    setRate(key, { ...card.rates[key]!, output: Number(e.target.value) })
                  }
                />
              </td>
            </tr>
          ))}
          {missing.map((key) => (
            <UnpricedRateRow key={key} modelKey={key} onCommit={(rate) => setRate(key, rate)} />
          ))}
        </tbody>
      </table>
      <div className="cc-cacheratios">
        <label className="cc-field cc-field-inline">
          Cached input costs
          <input
            type="number"
            min={0}
            step={0.05}
            className="cc-numinput"
            value={card.cache.read}
            onChange={(e) => setCacheRatios({ ...card.cache, read: Number(e.target.value) })}
          />
          × the input rate
        </label>
        <label className="cc-field cc-field-inline">
          Writing to cache costs
          <input
            type="number"
            min={0}
            step={0.05}
            className="cc-numinput"
            value={card.cache.write}
            onChange={(e) => setCacheRatios({ ...card.cache, write: Number(e.target.value) })}
          />
          × the input rate
        </label>
      </div>
      <button type="button" className="cc-btn" onClick={resetAll}>
        Reset to published prices
      </button>
    </div>
  );
}

/**
 * A model seen in the transcripts with no rate on the card. Held locally until BOTH figures
 * are typed: committing after the first one would price the model with a 0 in the other
 * column, and a half-priced model reads as cheap rather than as unknown.
 *
 * Committed when a field is LEFT (blur / Enter), never per keystroke: the commit moves the
 * model into the priced rows above and unmounts this row, so committing on change would yank
 * the field away mid-typing ("1" of "15").
 */
function UnpricedRateRow({
  modelKey,
  onCommit,
}: {
  modelKey: string;
  onCommit: (rate: { input: number; output: number }) => void;
}) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const commitIfComplete = () => {
    const i = Number(input);
    const o = Number(output);
    if (input !== "" && output !== "" && i >= 0 && o >= 0 && Number.isFinite(i) && Number.isFinite(o)) {
      onCommit({ input: i, output: o });
    }
  };
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };
  return (
    <tr>
      <td>
        {labelForTranscriptModel(modelKey)} <span className="cc-badge">no price</span>
      </td>
      <td className="cc-num">
        <input
          type="number"
          min={0}
          step={0.25}
          className="cc-numinput"
          placeholder="—"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={commitIfComplete}
          onKeyDown={commitOnEnter}
        />
      </td>
      <td className="cc-num">
        <input
          type="number"
          min={0}
          step={0.25}
          className="cc-numinput"
          placeholder="—"
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          onBlur={commitIfComplete}
          onKeyDown={commitOnEnter}
        />
      </td>
    </tr>
  );
}

// ---- C. Instructions -------------------------------------------------------

function InstructionsGroup() {
  const qc = useQueryClient();
  const memory = useQuery({
    queryKey: memoryKey,
    queryFn: () => unwrap(commands.readClaudeMemory()),
    staleTime: 5_000,
  });
  const write = useMutation({
    mutationFn: (text: string | null) => unwrap(commands.writeClaudeMemory(text)),
    onSettled: () => qc.invalidateQueries({ queryKey: memoryKey }),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const managed = memory.data?.managed_text ?? null;
  const current = draft ?? managed ?? "";
  // "Dirty" means the box differs from what is actually in the file — either the user
  // typed, or they clicked a suggested block and have not saved it yet.
  const dirty = draft !== null && draft.trim() !== (managed ?? "").trim();
  // Computed against what is actually IN the file, so the red lines are real removals
  // rather than a diff against the last thing typed.
  const diff = useMemo(() => diffLines(managed ?? "", current), [managed, current]);
  const changes = countChanges(diff);

  return (
    <SettingsGroup
      icon="file"
      title="Instructions for Claude"
    >
      <div className="cc-pad">
      <p className="cc-lede">
        Added to your global instructions file. Flight Deck only ever writes between its own
        markers — anything you wrote by hand is left alone.
      </p>
      {memory.data?.marker_error && (
        <p className="cc-error">
          <Ico name="alert" /> {memory.data.marker_error}. Fix the markers in the file by hand
          and reopen this page — nothing will be written until then.
        </p>
      )}

      <p className="cc-path">
        {memory.data?.path}
        {memory.data && !memory.data.exists && " (will be created)"}
        <button type="button" className="cc-linkbtn" onClick={() => setPreviewing((v) => !v)}>
          {previewing ? "Hide file" : "Preview file"}
        </button>
      </p>

      {previewing && (
        <pre className="cc-preview">{memory.data?.full_text ?? "(empty)"}</pre>
      )}

      {/* A catalogue, not a single button: this list is meant to grow, and framing it as
          "here is what we suggest" makes the one entry read as the first of several
          rather than as the feature itself. */}
      <h4 className="cc-blocks-head">Instructions we suggest adding</h4>
      <div className="cc-blocks">
        {INSTRUCTION_BLOCKS.map((block) => {
          const present = managed?.includes(block.body.slice(0, 40)) ?? false;
          return (
            <div key={block.id} className="cc-block">
              <div className="cc-block-head">
                <b>{block.title}</b>
                {present && <span className="cc-badge">in your instructions</span>}
              </div>
              <p className="cc-hint">{block.why}</p>
              <button
                type="button"
                className="cc-btn"
                disabled={!!memory.data?.marker_error || write.isPending}
                onClick={() => setDraft(block.body)}
              >
                {present ? "Replace with the latest version" : "Add it"}
              </button>
            </div>
          );
        })}
      </div>

      <label className="cc-field">
        The managed block
        <textarea
          className="cc-textarea"
          // A quiet cue that the box differs from the file; the diff below says how.
          data-unsaved={dirty ? "" : undefined}
          rows={10}
          value={current}
          placeholder="Nothing yet. Add a block above, or write your own here."
          disabled={!!memory.data?.marker_error}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {dirty && (
        <div className="cc-diff-wrap">
          <p className="cc-unsaved">
            <Ico name="alert" />
            Not saved yet
            {changes.added > 0 && <span className="cc-diff-add">+{changes.added}</span>}
            {changes.removed > 0 && <span className="cc-diff-del">−{changes.removed}</span>}
            <span className="cc-hint">what saving would change:</span>
          </p>
          {/* A real diff, not just a tint. Green says what arrives; red keeps what would
              LEAVE on screen until you save it away — the failure worth preventing is
              quietly dropping a line from a file you also edit by hand. */}
          <pre className="cc-diff">
            {withElisions(diff).map((line, i) =>
              line === null ? (
                <span key={i} className="cc-diff-gap">
                  ⋯
                </span>
              ) : (
                <span key={i} className={`cc-diff-line cc-diff-${line.kind}`}>
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} {line.text}
                </span>
              ),
            )}
          </pre>
        </div>
      )}
      <div className="cc-actions">
        <button
          type="button"
          className="cc-btn cc-btn-primary"
          disabled={draft === null || write.isPending || !!memory.data?.marker_error}
          // The draft is dropped only once the file has it: clearing it on click lost
          // everything typed whenever the save failed.
          onClick={() =>
            write.mutate(draft && draft.trim() ? draft : null, {
              onSuccess: () => setDraft(null),
            })
          }
        >
          {write.isPending ? "Saving…" : "Save to CLAUDE.md"}
        </button>
        {draft !== null && (
          <button type="button" className="cc-btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
        {managed && draft === null && (
          <button
            type="button"
            className="cc-btn"
            disabled={write.isPending}
            onClick={() => write.mutate(null)}
          >
            Remove the block
          </button>
        )}
      </div>
      {write.error && <p className="cc-error">{String(write.error)}</p>}
      </div>
    </SettingsGroup>
  );
}
