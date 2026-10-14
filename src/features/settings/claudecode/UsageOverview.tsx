// Settings → Claude Code → Overview. The page the tab opens on: how much Claude has worked
// on this Mac, and how that work splits between the main agent of each conversation and
// the helpers it hands work to — by model, by folder, over time.
//
// Same scan, same rate card and same charts as the helpers' bill (Helpers sub-page), which
// stays where it is: that page answers "is my helper ROUTING worth it", this one answers
// "where does Claude's work go". Colour means MODEL everywhere on this page; roles wear the
// neutral shades of `hueForRole`, so the two never read as each other.
import { useMemo, useState } from "react";

import {
  useActiveConversationId,
  useConversationRepo,
  useConversationsStore,
} from "../../../store/conversationsStore";
import { serverLabel } from "../../../store/remoteGates";
import { useRateCard } from "../../../store/subagentPricing";
import { Ico } from "../../../ui/kit";
import { SettingsGroup } from "../SettingsKit";
import { MetricToggle, StackedBarChart, StackedBarsOverTime, hueForRole, hueForSeries } from "./Charts";
import {
  PriceEditor,
  SPEND_WINDOWS,
  SpendLoading,
  SpendScanNotices,
  Tile,
  useClaudeSpend,
} from "./ClaudeCodeSection";
import {
  applyFilter,
  breakdown,
  dailySeries,
  dayCutoff,
  formatCost,
  formatShare,
  formatTokens,
  shareOf,
  splitByRole,
  summarizeByRole,
  type BarMetric,
  type RoleSummary,
  type SplitRow,
} from "./spend";

/** How a bar chart's figures read in the unit it is measured in. */
const formatFor = (metric: BarMetric) => (metric === "output" ? formatTokens : formatCost);

type ColourBy = "role" | "model";

export function ClaudeCodeOverview({ onOpenHelpers }: { onOpenHelpers: () => void }) {
  const spend = useClaudeSpend();
  const card = useRateCard();
  const convId = useActiveConversationId();
  const repo = useConversationRepo(convId);
  // A conversation on a paired server writes its transcripts THERE: this Mac's scan cannot
  // see them, and its folder path names a directory on the server — so no "This folder"
  // shortcut for it (it would filter to whatever local clone sits at that path).
  const machineId = repo?.machineId ?? null;
  const server = useConversationsStore((s) => (machineId ? serverLabel(s.machines, machineId) : null));
  const activeFolder = server != null ? null : (repo?.path ?? null);

  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [folder, setFolder] = useState<string | null>(null);
  const [colourBy, setColourBy] = useState<ColourBy>("role");
  const [tableBy, setTableBy] = useState<"model" | "repo">("model");
  // Each bar chart has its own switch, beside its title: tokens unless asked otherwise.
  const [rolesMetric, setRolesMetric] = useState<BarMetric>("output");
  const [folderMetric, setFolderMetric] = useState<BarMetric>("output");
  const [editingPrices, setEditingPrices] = useState(false);

  const buckets = spend.data?.buckets ?? [];
  const since = windowDays === null ? null : dayCutoff(windowDays);
  const filtered = useMemo(
    () => applyFilter(buckets, { since, repo: folder, includeWorkflow: true }),
    [buckets, since, folder],
  );
  // Claude Code deletes old transcripts itself, so "All time" only reaches as far back as
  // what is still on disk. Said whenever the chosen window reaches past it — otherwise a
  // 90-day view of 30 days of data passes for a quiet quarter.
  const oldestDay = useMemo(
    () => buckets.reduce<string | null>((min, b) => (min === null || b.day < min ? b.day : min), null),
    [buckets],
  );
  // A day of slack: the CLI prunes by file age, so a 30-day window over 30 days of
  // transcripts routinely starts one day before the oldest turn — not worth a warning.
  const windowOutrunsData =
    oldestDay !== null && (since === null || since < dayBefore(oldestDay));
  const folders = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of buckets) seen.set(b.repo, b.repo_label);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [buckets]);

  const roles = useMemo(() => summarizeByRole(filtered, card), [filtered, card]);
  const totals = useMemo(() => {
    let output = 0;
    let turns = 0;
    let cost = 0;
    let unpriced = false;
    for (const r of roles) {
      output += r.outputTokens;
      turns += r.turns;
      if (r.cost === null) unpriced = true;
      else cost += r.cost;
    }
    return { output, turns, cost, unpriced };
  }, [roles]);
  const main = roles.find((r) => r.role === "main")!;
  const helperOutput = totals.output - main.outputTokens;
  // A cost share needs EVERY role priced — dividing a partial sum would invent a ratio.
  const helperCostShare =
    totals.unpriced || main.cost === null ? null : shareOf(totals.cost - main.cost, totals.cost);

  const daily = useMemo(() => dailySeries(filtered, card, "output", colourBy), [filtered, card, colourBy]);
  const modelsPerRole = useMemo(
    () => breakdown(filtered, "role", "model", card, rolesMetric),
    [filtered, card, rolesMetric],
  );
  const perFolder = useMemo(
    () => breakdown(filtered, "repo", colourBy, card, folderMetric),
    [filtered, card, colourBy, folderMetric],
  );
  const split = useMemo(() => splitByRole(filtered, tableBy, card), [filtered, tableBy, card]);
  const hueFor = colourBy === "role" ? hueForRole : hueForSeries;
  const nothingRead =
    !!spend.error ||
    (!!spend.data &&
      spend.data.files_scanned === 0 &&
      (spend.data.warnings.length > 0 || spend.data.files_unreadable > 0));

  return (
    <SettingsGroup icon="gauge" title="Claude usage">
      <div className="cc-pad">
        <p className="cc-lede">
          Every Claude turn on this Mac — the main agent of each conversation and the helpers
          it hands work to — read from the transcripts Claude Code already writes. Nothing
          extra is recorded.
        </p>
        {server != null ? (
          <p className="cc-hint">
            Counted from this Mac&apos;s transcripts only — conversations on {server} keep theirs
            on that server and are not included.
          </p>
        ) : null}
        <p className="cc-disclaimer">
          <Ico name="ask" />
          Money figures are <b>Anthropic API list prices</b>. On a Claude subscription none of
          this is billed — read them as the relative weight of one model or role against
          another, not as an invoice.
          <button type="button" className="cc-linkbtn" onClick={() => setEditingPrices((v) => !v)}>
            {editingPrices ? "Done" : "Edit prices"}
          </button>
        </p>
        {editingPrices && <PriceEditor buckets={buckets} />}
        <SpendScanNotices spend={spend} />

        <div className="cc-filters">
          <select
            className="cc-select cc-select-sm"
            aria-label="Time range"
            value={windowDays === null ? "all" : String(windowDays)}
            onChange={(e) => setWindowDays(e.target.value === "all" ? null : Number(e.target.value))}
          >
            {SPEND_WINDOWS.map((w) => (
              <option key={w.label} value={w.days === null ? "all" : String(w.days)}>
                {w.label}
              </option>
            ))}
          </select>
          <select
            className="cc-select cc-select-sm"
            aria-label="Folder"
            value={folder ?? ""}
            onChange={(e) => setFolder(e.target.value || null)}
          >
            <option value="">All folders</option>
            {folders.map(([path, label]) => (
              <option key={path} value={path}>
                {label}
              </option>
            ))}
          </select>
          {activeFolder && folders.some(([p]) => p === activeFolder) && folder !== activeFolder && (
            <button type="button" className="cc-linkbtn" onClick={() => setFolder(activeFolder)}>
              This folder
            </button>
          )}
          <div className="cc-seg cc-filters-end" role="group" aria-label="Colour the charts by">
            {(["role", "model"] as const).map((c) => (
              <button
                key={c}
                type="button"
                data-on={colourBy === c ? "" : undefined}
                aria-pressed={colourBy === c}
                onClick={() => setColourBy(c)}
              >
                {c === "role" ? "By role" : "By model"}
              </button>
            ))}
          </div>
        </div>

        {windowOutrunsData && (
          <p className="cc-hint cc-retention">
            The oldest transcript on this Mac is from {longDate(oldestDay)}. Claude Code deletes
            transcripts after its cleanup period (<code>cleanupPeriodDays</code>, 30 days
            unless changed), so older work is not counted.
          </p>
        )}

        {spend.isLoading ? (
          <SpendLoading />
        ) : (
        <>
        {/* Tokens lead, money trails — the same rule as the helpers' bill: a dollar figure
            first made a subscription read as an invoice. */}
        <div className="cc-tiles">
          <Tile label="Output tokens" value={formatTokens(totals.output)} />
          <Tile label="Turns" value={totals.turns.toLocaleString("en-US")} />
          <Tile
            label="Done by helpers"
            value={formatShare(shareOf(helperOutput, totals.output))}
            note={helperCostShare === null ? "of the output" : `of the output · ${formatShare(helperCostShare)} at API rates`}
          />
          <Tile
            label="At API rates"
            value={totals.unpriced ? `${formatCost(totals.cost)}+` : formatCost(totals.cost)}
            note="not your bill"
          />
        </div>

        <RoleShares roles={roles} />
        <RoleTable roles={roles} nothingRead={nothingRead} />

        {/* Keyed by the colouring: each chart remembers which series the reader hid, and a
            role key hidden in one colouring must not linger as a phantom in the other. */}
        <StackedBarsOverTime
          key={`daily-${colourBy}`}
          title="Output tokens per day"
          days={daily.days}
          series={daily.series}
          formatValue={formatTokens}
          hueFor={hueFor}
        />

        <StackedBarChart
          title="Which models each role runs on"
          titleAction={<MetricToggle value={rolesMetric} onChange={setRolesMetric} />}
          rows={modelsPerRole.map((r) => ({ key: r.key, label: r.label, total: r.total, parts: r.parts }))}
          formatValue={formatFor(rolesMetric)}
        />

        <StackedBarChart
          key={`folder-${colourBy}`}
          title={colourBy === "role" ? "Per folder, main agents vs helpers" : "Per folder, by model"}
          titleAction={<MetricToggle value={folderMetric} onChange={setFolderMetric} />}
          rows={perFolder.map((r) => ({
            key: r.key,
            label: r.label,
            // The absolute path, on hover — two folders can share a name.
            detail: r.key,
            total: r.total,
            parts: r.parts,
          }))}
          formatValue={formatFor(folderMetric)}
          hueFor={hueFor}
        />

        <div className="cc-tablehead">
          <div className="cc-seg" role="group" aria-label="Break the table down by">
            {(["model", "repo"] as const).map((g) => (
              <button
                key={g}
                type="button"
                data-on={tableBy === g ? "" : undefined}
                aria-pressed={tableBy === g}
                onClick={() => setTableBy(g)}
              >
                {g === "model" ? "By model" : "By folder"}
              </button>
            ))}
          </div>
        </div>
        <SplitTable rows={split} by={tableBy} nothingRead={nothingRead} />
        </>
        )}

        <p className="cc-hint cc-footnote">
          Which model each helper runs on, and the per-helper bill, live under{" "}
          <button type="button" className="cc-linkbtn" onClick={onOpenHelpers}>
            Helpers
          </button>
          .
        </p>
      </div>
    </SettingsGroup>
  );
}

/**
 * Two 100 % bars, one above the other: who produced the OUTPUT, and who accounts for the
 * API-rate COST. Side by side they answer the question this page exists for — a main agent
 * that writes half the tokens can account for most of the cost, because it re-reads the
 * whole conversation every turn.
 */
function RoleShares({ roles }: { roles: RoleSummary[] }) {
  const output = roles.reduce((n, r) => n + r.outputTokens, 0);
  if (output === 0) return null;
  const costKnown = roles.every((r) => r.cost !== null);
  const cost = costKnown ? roles.reduce((n, r) => n + (r.cost ?? 0), 0) : 0;
  const lines: Array<{ label: string; parts: Array<{ role: RoleSummary; share: number }> }> = [
    { label: "Output", parts: roles.map((r) => ({ role: r, share: r.outputTokens / output })) },
  ];
  if (costKnown && cost > 0) {
    lines.push({
      label: "At API rates",
      parts: roles.map((r) => ({ role: r, share: (r.cost ?? 0) / cost })),
    });
  }
  return (
    <figure className="cc-chart cc-shares">
      <figcaption className="cc-chart-title">Main agents vs helpers</figcaption>
      {lines.map((line) => (
        <div key={line.label} className="cc-share-line">
          <span className="cc-share-label">{line.label}</span>
          <div className="cc-share-bar" role="img" aria-label={`${line.label}: ${describe(line.parts)}`}>
            {line.parts
              .filter((p) => p.share > 0)
              .map((p) => (
                <span
                  key={p.role.role}
                  className="cc-share-seg"
                  style={{ flexGrow: p.share, background: hueForRole(p.role.role) }}
                  title={`${p.role.label} — ${formatShare(p.share)}`}
                />
              ))}
          </div>
          <span className="cc-share-values">{describe(line.parts)}</span>
        </div>
      ))}
      {!costKnown && (
        <p className="cc-hint">
          Some models here have no price, so the split at API rates is not shown — set one under
          Edit prices.
        </p>
      )}
    </figure>
  );
}

/** `2026-09-13` → `2026-09-12`, in UTC like every day in the scan. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** `2026-09-13` → `13 Sep 2026`. */
function longDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function describe(parts: Array<{ role: RoleSummary; share: number }>): string {
  return parts
    .filter((p) => p.share > 0)
    .map((p) => `${p.role.label} ${formatShare(p.share)}`)
    .join(" · ");
}

/** The comparison itself: one row per role, the figures that explain the difference. */
function RoleTable({ roles, nothingRead }: { roles: RoleSummary[]; nothingRead: boolean }) {
  // A workflow row of zeros is noise for anyone who has never run one; main and helpers
  // always show, so "none" reads as none rather than as "not measured".
  const shown = roles.filter((r) => r.role !== "workflow" || r.turns > 0);
  const any = roles.some((r) => r.turns > 0);
  return (
    <table className="cc-table cc-roletable">
      <thead>
        <tr>
          <th>Who</th>
          <th className="cc-num">Turns</th>
          <th className="cc-num">Output</th>
          <th className="cc-num" title="Average prompt per turn: new input + input read from cache + input written to cache">
            Context / turn
          </th>
          <th className="cc-num" title="Share of that prompt served from the prompt cache">
            From cache
          </th>
          <th className="cc-num">At API rates</th>
        </tr>
      </thead>
      <tbody>
        {any &&
          shown.map((r) => (
            <tr key={r.role}>
              <td>
                <span className="cc-swatch" style={{ background: hueForRole(r.role) }} aria-hidden />
                {r.label}
              </td>
              <td className="cc-num">{r.turns.toLocaleString("en-US")}</td>
              <td className="cc-num">{formatTokens(r.outputTokens)}</td>
              <td className="cc-num">{r.turns > 0 ? formatTokens(Math.round(r.contextPerTurn)) : "—"}</td>
              <td className="cc-num">{formatShare(r.cacheReuse)}</td>
              <td className="cc-num">{r.turns > 0 ? formatCost(r.cost) : "—"}</td>
            </tr>
          ))}
        {!any && (
          <tr>
            <td colSpan={6} className="cc-hint">
              {nothingRead
                ? "Nothing could be read — see the warning above."
                : "No Claude turns in this range."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Per model or per folder: how much each role produced, and the helpers' share of it. */
function SplitTable({
  rows,
  by,
  nothingRead,
}: {
  rows: SplitRow[];
  by: "model" | "repo";
  nothingRead: boolean;
}) {
  return (
    <table className="cc-table">
      <thead>
        <tr>
          <th>{by === "model" ? "Model" : "Folder"}</th>
          <th className="cc-num">Main agents</th>
          <th className="cc-num">Helpers</th>
          <th className="cc-num">Helpers&apos; share</th>
          <th className="cc-num">Turns</th>
          <th className="cc-num">At API rates</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td title={r.detail}>
              {by === "model" && (
                <span className="cc-swatch" style={{ background: hueForSeries(r.key) }} aria-hidden />
              )}
              {r.label}
            </td>
            <td className="cc-num">{formatTokens(r.mainOutput)}</td>
            <td className="cc-num">{formatTokens(r.helperOutput)}</td>
            <td className="cc-num">
              <span className="cc-minishare" aria-hidden>
                <span style={{ width: `${(r.helperShare ?? 0) * 100}%` }} />
              </span>
              {formatShare(r.helperShare)}
            </td>
            <td className="cc-num">{r.turns.toLocaleString("en-US")}</td>
            <td className="cc-num">{formatCost(r.cost)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="cc-hint">
              {nothingRead
                ? "Nothing could be read — see the warning above."
                : "No Claude turns in this range."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
