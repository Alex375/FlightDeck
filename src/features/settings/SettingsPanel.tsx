// Settings modal — a left-rail tabbed panel. The active section is shared state so
// deep-links (e.g. the update banner, the auth warning bar) can open it straight onto a
// given tab and sub-tab.
//
// The rail is deliberately SHORT: a tab is a top-level CONCERN, not a single page.
// Everything the app shows lives under "Display"; everything Claude-specific under
// "Claude Code"; who you are signed in as and what the app may do to this machine under
// "General". Sub-tabs carry the rest — growing the rail is the wrong axis.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { demoteBypassConversations, wipeAllData } from "../../store/conversationsStore";
import { usePermissionPrefs } from "../../store/permissions";
import { useSettingsUi, type SettingsSection } from "../../store/settingsUi";
import { useDisplay, type MinimapHoverMode } from "../../store/display";
import { useCaffeinate, type CaffeinateMode } from "../../store/caffeinate";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { TosseMark } from "../../ui/TosseMark";
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, formatZoom, nextZoom, prevZoom } from "../../ui/zoom";
import { UpdateSection } from "./UpdateSection";
import { ClaudeCliSection } from "./ClaudeCliSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConversationSection } from "./ConversationSection";
import { ModelsSection } from "./ModelsSection";
import { ClaudeCodeHelpers, ClaudeCodeInstructions } from "./claudecode/ClaudeCodeSection";
import { useClaudeAccount } from "../../ipc/useAccounts";
import { AccountsSection } from "./AccountsSection";
import { TosseSection } from "./TosseSection";
import { ShortcutsSection } from "./ShortcutsSection";
import {
  AgentControlGroup,
  RemoteAccessGroup,
  RemoteServersGroup,
  VoiceBridgeGroup,
} from "./ControlSection";
import { VoiceAgentSection } from "./VoiceAgentSection";
import { ComposerSection } from "./ComposerSection";
import { OutputStylePrefs } from "./OutputStyleSection";
import { OptionCardRail, PageHead, SettingsGroup, SubTabs, ToggleRow } from "./SettingsKit";
import { SETTINGS_INDEX, searchSettings, type SettingEntry } from "./settingsSearch";
import styles from "./SettingsPanel.module.css";

// `mark` overrides `icon` for a tab that carries a BRAND logo rather than a kit glyph —
// the rest of the rail stays on the shared icon set.
const TABS: Array<{
  id: SettingsSection;
  label: string;
  icon: string;
  mark?: ReactNode;
  /** Hidden until a Claude account is connected. */
  needsClaude?: boolean;
}> = [
  // You and this machine: the accounts the agents sign in with, and the anti-sleep hold.
  { id: "general", label: "General", icon: "cog" },
  // TOSSE sits next to the accounts (both are "connect to a service") but stays its own
  // tab: General → Accounts signs the AGENTS in to their model providers, this signs YOU
  // in to the CRM.
  { id: "tosse", label: "TOSSE", icon: "list", mark: <TosseCrmMark className="sm" /> },
  // Everything the app SHOWS, behind this tab's sub-tabs: the app's look and motion, the
  // thread (Markdown included), timings, the composer bar, the model picker, and the
  // manual order of conversations and cards. Was a General sub-tab plus two top-level
  // tabs of its own (Conversation, Reordering).
  { id: "display", label: "Display", icon: "sidebar" },
  // Backend-specific by design, and only present while that backend is CONNECTED: the
  // page is Claude model names, Claude file layout and Claude-only CLI flags end to end,
  // so an abstraction over both backends would have to speak in euphemisms. A Codex twin
  // would be its own tab. Holds what used to be the top-level "Behavior" tab (output
  // style, bypass permissions) — both are Claude-only and do nothing for Codex.
  { id: "claudeCode", label: "Claude Code", icon: "code", needsClaude: true },
  { id: "shortcuts", label: "Shortcuts", icon: "key" },
  // Agents piloting the app: the in-process MCP server, the voice agent, the bridge.
  { id: "control", label: "Control", icon: "wand" },
  // OS channels + the fleet readout + background-task alerts, behind this tab's sub-tabs.
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "updates", label: "Updates", icon: "refresh" },
  { id: "data", label: "Data", icon: "trash" },
];

/** The tabs that split their cards behind a pill row instead of stacking them all. The
 *  ids are mirrored by `settingsSearch.SETTINGS_SUBS` (a unit test keeps the search index
 *  from pointing at a sub-tab that doesn't exist). */
const GENERAL_SUBS = [
  { id: "accounts", label: "Accounts", icon: "users" },
  { id: "system", label: "System", icon: "cog" },
] as const;

/** One tab for everything the app shows, split by the SURFACE each pref acts on rather
 *  than by the store it lives in — so "where do I turn that off?" has one answer per
 *  surface: the app itself (Appearance), the conversation (Thread / Durations), the
 *  composer bar, the model picker, and the order things are listed in. */
const DISPLAY_SUBS = [
  { id: "appearance", label: "Appearance", icon: "eye" },
  { id: "thread", label: "Thread", icon: "chat" },
  { id: "timing", label: "Durations", icon: "clock" },
  { id: "composer", label: "Composer", icon: "wand" },
  { id: "models", label: "Models", icon: "spark" },
  { id: "order", label: "Order", icon: "reorder" },
] as const;

/** Claude Code, widest scope first: the instructions every conversation starts from, then
 *  how Claude itself behaves, then the helpers it delegates to and what they cost. */
const CLAUDE_CODE_SUBS = [
  { id: "instructions", label: "Instructions", icon: "file" },
  { id: "behavior", label: "Behavior", icon: "shield" },
  { id: "helpers", label: "Helpers", icon: "bot" },
] as const;

const CONTROL_SUBS = [
  { id: "agents", label: "In-app agents", icon: "wand" },
  { id: "voice", label: "Voice agent", icon: "mic" },
  { id: "remote", label: "Remote", icon: "globe" },
  { id: "bridge", label: "Bridge", icon: "bell" },
] as const;

const NOTIFICATIONS_SUBS = [
  { id: "channels", label: "Channels", icon: "bell" },
  { id: "fleet", label: "Fleet", icon: "grid" },
  { id: "background", label: "Background", icon: "term" },
] as const;

type GeneralSub = (typeof GENERAL_SUBS)[number]["id"];
type DisplaySub = (typeof DISPLAY_SUBS)[number]["id"];
type ClaudeCodeSub = (typeof CLAUDE_CODE_SUBS)[number]["id"];
type ControlSub = (typeof CONTROL_SUBS)[number]["id"];
type NotificationsSub = (typeof NOTIFICATIONS_SUBS)[number]["id"];

/** The rail label of a section, for a search result's breadcrumb. */
function tabLabel(section: SettingsSection): string {
  return TABS.find((t) => t.id === section)?.label ?? section;
}

/** What the panel shows instead of a tab while the search box has text. */
function SearchResults({
  query,
  sections,
  onPick,
}: {
  query: string;
  /** The tabs currently in the rail — a result in a hidden tab (Claude Code while no
   *  Claude account is signed in) would bounce the user back to General. */
  sections: ReadonlySet<SettingsSection>;
  onPick: (entry: SettingEntry) => void;
}) {
  const results = useMemo(
    () =>
      searchSettings(
        query,
        SETTINGS_INDEX.filter((e) => sections.has(e.section)),
      ),
    [query, sections],
  );
  if (results.length === 0) {
    return (
      <div>
        <PageHead title="Search" subtitle={`Nothing matches “${query}”.`} />
        <div className={styles.desc}>
          Try a word from the setting&rsquo;s name (“zoom”, “wake”, “bypass”), or browse the tabs
          on the left.
        </div>
      </div>
    );
  }
  return (
    <div>
      <PageHead
        title="Search"
        subtitle={`${results.length} setting${results.length > 1 ? "s" : ""} matching “${query}”.`}
      />
      <div className={styles.results}>
        {results.map((r) => (
          <button
            key={`${r.section}/${r.sub ?? ""}/${r.title}`}
            type="button"
            className={styles.result}
            onClick={() => onPick(r)}
          >
            <span className={styles.resultTitle}>{r.title}</span>
            <span className={styles.resultPath}>
              {tabLabel(r.section)} › {r.group}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const section = useSettingsUi((s) => s.section);
  const setSection = useSettingsUi((s) => s.setSection);
  // The Claude tab follows the last SUCCESSFUL status read: it appears on a positive
  // "logged in", goes away on a successful "signed out", and does NOT disappear on a
  // failed read — a Keychain hiccup must not evaporate a tab the user is standing in
  // (react-query keeps the last good `data` through an error).
  // `claudeSeen` is that last-known-good latch (same discipline as the artifact header).
  const claudeAccount = useClaudeAccount(open);
  const [claudeSeen, setClaudeSeen] = useState(false);
  const claudeLoggedIn = claudeAccount.data?.loggedIn;
  useEffect(() => {
    if (claudeLoggedIn !== undefined) setClaudeSeen(claudeLoggedIn);
  }, [claudeLoggedIn]);
  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.needsClaude || claudeSeen),
    [claudeSeen],
  );
  const visibleSections = useMemo(
    () => new Set<SettingsSection>(visibleTabs.map((t) => t.id)),
    [visibleTabs],
  );
  // Standing on a tab that just became unavailable (signed out) — fall back rather than
  // render an empty pane.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === section)) setSection("general");
  }, [visibleTabs, section, setSection]);
  const subs = useSettingsUi((s) => s.subs);
  const setSub = useSettingsUi((s) => s.setSub);
  const revealSetting = useSettingsUi((s) => s.revealSetting);
  const generalSub = (subs.general ?? "accounts") as GeneralSub;
  const displaySub = (subs.display ?? "appearance") as DisplaySub;
  const claudeCodeSub = (subs.claudeCode ?? "instructions") as ClaudeCodeSub;
  const controlSub = (subs.control ?? "agents") as ControlSub;
  const notificationsSub = (subs.notifications ?? "channels") as NotificationsSub;
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // App version, read from the bundle (tauri.conf.json — the runtime source of
  // truth, kept in sync by `pnpm bump`). Null outside the Tauri webview (e.g. a
  // plain browser dev server), in which case we just hide the chip.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [open]);

  // Close on Escape, but never mid-wipe. The app-wide capture guard (App.tsx) always
  // preventDefaults Escape, so gating on `defaultPrevented` here would mean the panel
  // NEVER closes — that signal is now the guard's, not a "higher layer consumed it"
  // marker. One-Escape-one-layer is upheld instead by any ConfirmDialog mounted inside
  // calling stopPropagation, so its Escape never reaches this window-level handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      // One Escape, one layer: a search in progress is the innermost one, so it
      // clears first and the panel stays open.
      if (query.trim().length > 0) {
        setQuery("");
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy, query]);

  if (!open) return null;

  async function dropAll() {
    setBusy(true);
    try {
      await wipeAllData();
      onClose();
    } catch (e) {
      console.error("wipeAllData failed:", e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function close() {
    if (busy) return;
    setConfirming(false);
    onClose();
  }

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <span className={styles.headIcon}>
            <Ico name="cog" className="sm" />
          </span>
          <span className={styles.title}>Settings</span>
          <span className={styles.searchBox}>
            <Ico name="search" className="sm" />
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              placeholder="Search settings…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search settings"
            />
          </span>
          <button className={styles.close} onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.layout}>
          <nav className={styles.rail} aria-label="Settings sections">
            <div className={styles.railCap}>Settings</div>
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.railItem}
                data-on={!searching && section === t.id ? "" : undefined}
                onClick={() => {
                  setQuery("");
                  setSection(t.id);
                }}
              >
                {t.mark ?? <Ico name={t.icon} className="sm" />}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {searching && (
              <SearchResults
                query={query}
                sections={visibleSections}
                onPick={(entry) => {
                  setQuery("");
                  revealSetting({
                    section: entry.section,
                    sub: entry.sub,
                    title: entry.flash ?? entry.title,
                  });
                }}
              />
            )}

            {!searching && section === "general" && (
              <div>
                <PageHead
                  title="General"
                  subtitle="Who your agents sign in as, and what the app may do to this machine."
                />

                <div className={styles.about}>
                  <span className={styles.aboutMark}>
                    <TosseMark />
                  </span>
                  <div>
                    <div className={styles.appName}>Flight Deck</div>
                    <div className={styles.appTag}>
                      Desktop app to drive Claude Code.
                    </div>
                  </div>
                  {version && <span className={styles.version}>v{version}</span>}
                </div>

                <SubTabs
                  tabs={GENERAL_SUBS}
                  active={generalSub}
                  onSelect={(id) => setSub("general", id)}
                  ariaLabel="General settings"
                />
                {/* Accounts was a top-level tab; it is the first thing this one is about. */}
                {generalSub === "accounts" && <AccountsSection embedded />}
                {/* "Bypass permissions" is NOT here — it is a Claude-only CLI flag and
                    lives in Claude Code → Behavior. System is the machine card. */}
                {generalSub === "system" && <CaffeinatePrefs />}
              </div>
            )}

            {!searching && section === "tosse" && <TosseSection />}

            {!searching && section === "display" && (
              <div>
                <PageHead
                  title="Display"
                  subtitle="What the app shows and how it reads — its look and motion, the conversation, the composer bar, the model picker, and the order things are listed in."
                />
                {/* One sub-page at a time. Appearance and Motion share a page (both are
                    "how the app itself looks"); Markdown sits with the rest of the thread
                    rather than on a page of its own. */}
                <SubTabs
                  tabs={DISPLAY_SUBS}
                  active={displaySub}
                  onSelect={(id) => setSub("display", id)}
                  ariaLabel="Display settings"
                />
                {displaySub === "appearance" && (
                  <>
                    <AppearancePrefs />
                    <MotionPrefs />
                  </>
                )}
                {displaySub === "thread" && (
                  <>
                    <ThreadPrefs />
                    <ConversationSection embedded />
                  </>
                )}
                {displaySub === "timing" && <TimingPrefs />}
                {displaySub === "composer" && <ComposerSection embedded />}
                {displaySub === "models" && <ModelsSection embedded />}
                {displaySub === "order" && <OrderingPrefs />}
              </div>
            )}

            {!searching && section === "claudeCode" && (
              <div>
                <PageHead
                  title="Claude Code"
                  subtitle="The instructions Claude works from, how it behaves, and which model each of its helpers runs on."
                />
                {/* Claude-only, all of it: the output style and the bypass-permissions
                    unlock came from the old top-level "Behavior" tab — one writes
                    `~/.claude/settings.json`, the other arms a `claude` CLI flag. Neither
                    does anything for a Codex conversation, which is why they follow this
                    tab's visibility. */}
                <SubTabs
                  tabs={CLAUDE_CODE_SUBS}
                  active={claudeCodeSub}
                  onSelect={(id) => setSub("claudeCode", id)}
                  ariaLabel="Claude Code settings"
                />
                {claudeCodeSub === "instructions" && <ClaudeCodeInstructions />}
                {claudeCodeSub === "behavior" && (
                  <>
                    <OutputStylePrefs />
                    <PermissionPrefs />
                  </>
                )}
                {claudeCodeSub === "helpers" && <ClaudeCodeHelpers />}
              </div>
            )}

            {!searching && section === "shortcuts" && <ShortcutsSection />}

            {!searching && section === "control" && (
              <div className={styles.page}>
                <PageHead
                  title="Control"
                  subtitle="Let agents pilot the app — from inside a conversation, by voice, from your phone, or from an external client."
                />
                {/* Order: in-app control, the built-in voice agent, remote access
                    (SSH hosts + phone), then the bridge for EXTERNAL clients (most
                    niche last). One sub-page at a time — these are five unrelated
                    systems and stacking them made the tab a scroll. */}
                <SubTabs
                  tabs={CONTROL_SUBS}
                  active={controlSub}
                  onSelect={(id) => setSub("control", id)}
                  ariaLabel="Control settings"
                />
                {controlSub === "agents" && <AgentControlGroup />}
                {controlSub === "voice" && <VoiceAgentSection />}
                {controlSub === "remote" && (
                  <>
                    <RemoteServersGroup />
                    <RemoteAccessGroup />
                  </>
                )}
                {controlSub === "bridge" && <VoiceBridgeGroup />}
              </div>
            )}

            {!searching && section === "notifications" && (
              <div className={styles.page}>
                <PageHead
                  title="Notifications"
                  subtitle="When and how the app signals you — the OS channels, the fleet readout, and the background-task alert."
                />
                {/* The fleet readout and the background-task alert moved here from the old
                    General → Alerts, next to the OS channels: all of it is "how the app
                    signals you", and it was split across two places before. */}
                <SubTabs
                  tabs={NOTIFICATIONS_SUBS}
                  active={notificationsSub}
                  onSelect={(id) => setSub("notifications", id)}
                  ariaLabel="Notifications settings"
                />
                {notificationsSub === "channels" && <NotificationsSection embedded />}
                {notificationsSub === "fleet" && <FleetBannerPrefs />}
                {notificationsSub === "background" && <BackgroundTaskPrefs />}
              </div>
            )}

            {/* Two updaters, one tab: the app itself, then the `claude` binary it drives.
                One page heading covers both — each has its own titled card below. */}
            {!searching && section === "updates" && (
              <div>
                <PageHead
                  title="Updates"
                  subtitle="Flight Deck and the Claude Code CLI it drives."
                />
                <UpdateSection />
                <ClaudeCliSection />
              </div>
            )}

            {!searching && section === "data" && (
              <div>
                <PageHead
                  title="Data"
                  subtitle="Manage the app's local data."
                />
                <div className={styles.desc}>
                  Deletes all saved conversations and repositories, and wipes the local database.
                  Claude's on-disk transcripts are not touched. This cannot be undone.
                </div>

                {confirming ? (
                  <div className={styles.row}>
                    <button
                      className={`${styles.btn} ${styles.danger}`}
                      onClick={() => void dropAll()}
                      disabled={busy}
                    >
                      {busy ? "Deleting…" : "Confirm deletion"}
                    </button>
                    <button
                      className={`${styles.btn} ${styles.ghost}`}
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className={`${styles.btn} ${styles.danger}`}
                    onClick={() => setConfirming(true)}
                  >
                    Delete all…
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const MINIMAP_HOVER_MODES: Array<{ id: MinimapHoverMode; label: string; desc: string }> = [
  {
    id: "summary",
    label: "Summary",
    desc: "One line: the summary of that message, or its first line when it never needed one. Reads at a glance and never covers the conversation.",
  },
  {
    id: "full",
    label: "Whole message",
    desc: "The message as you sent it, in a preview that can span several lines (long ones are clipped). Faithful, but it takes up more of the thread.",
  },
];

/** The "Appearance" card of Display → Appearance: the app's global look and what the
 *  Flight Deck card shows. Shares its sub-page with {@link MotionPrefs} — both answer
 *  "how does the app itself look", as opposed to the thread ({@link ThreadPrefs}). */
function AppearancePrefs() {
  const uiZoom = useDisplay((s) => s.uiZoom);
  const workflowLiveCard = useDisplay((s) => s.workflowLiveCard);
  const workflowAgentDetail = useDisplay((s) => s.workflowAgentDetail);
  const sidebarStatePills = useDisplay((s) => s.sidebarStatePills);
  const composerStatusBand = useDisplay((s) => s.composerStatusBand);
  const set = useDisplay((s) => s.set);
  return (
    <>
      <SettingsGroup title="Appearance" icon="eye">
        <ToggleRow
          title="Interface zoom"
          hint={
            <>
              Scales the <strong>whole app</strong> — conversation, Flight Deck, editor and
              terminal — like a browser's zoom. <strong>100% by default.</strong> Also on{" "}
              <strong>⌘+</strong> / <strong>⌘−</strong>, and <strong>⌘0</strong> to come back
              to 100%.
            </>
          }
          control={<ZoomStepper zoom={uiZoom} onChange={(v) => set({ uiZoom: v })} />}
        />
        <ToggleRow
          title="Tinted conversation rows"
          hint={
            <>
              In the sidebar, a conversation's state is <strong>the colour of its row</strong>:
              green while it runs — with the working dots and the{" "}
              <strong>time since your last message</strong> under its name — green-violet for
              background work, amber when it needs you, blue to review, red on an error. Idle
              and stopped conversations stay plain. Off → the classic status dot in front of
              the name. <strong>On by default.</strong>
            </>
          }
          checked={sidebarStatePills}
          onChange={(v) => set({ sidebarStatePills: v })}
          label="Show each conversation's state as its row colour"
        />
        <ToggleRow
          title="Status inside the composer"
          hint={
            <>
              “Conversation ended”, a question waiting for you, an error, background work: the
              conversation's status shows as a <strong>band at the top of the composer</strong>,
              whose border takes the state's colour, with <strong>Mark as seen</strong> (⌘↵)
              and <strong>Continue</strong> right there. Off → the classic full-width bar
              above the composer. <strong>On by default.</strong>
            </>
          }
          checked={composerStatusBand}
          onChange={(v) => set({ composerStatusBand: v })}
          label="Show the conversation's status inside the composer"
        />
        <ToggleRow
          title="Live workflow on the Flight Deck card"
          hint={
            <>
              While a <strong>workflow</strong> is running, shows its live progress on the card:
              current phase, <strong>how many of its agents are working</strong>, and how far along
              the run is — read from the run's own journal, so the counts are exact. The wire
              reports a whole run as a single task, so without this the card only shows the
              generic background-task chip. <strong>On by default.</strong>
            </>
          }
          checked={workflowLiveCard}
          onChange={(v) => set({ workflowLiveCard: v })}
          label="Show live workflow progress on cards"
        />
        <ToggleRow
          title="Per-agent detail in the workflow view"
          hint={
            <>
              In a running workflow's detail view, break each phase open into its individual{" "}
              <strong>agents</strong> — their real labels, a running/done dot, and a one-line{" "}
              <strong>“doing X now”</strong> read from each agent's transcript — the closest we
              get to Claude Code's own <code>/workflows</code> readout. The wire gives no live
              agent→label mapping, so labels are matched to the run <strong>by spawn order</strong>{" "}
              (approximate, and stated as such); the exact mapping arrives with the end-of-run
              report. Off → the flat launched/running/done counts and the opaque id list.{" "}
              <strong>On by default.</strong>
            </>
          }
          checked={workflowAgentDetail}
          onChange={(v) => set({ workflowAgentDetail: v })}
          label="Show each agent under its phase, live"
        />
      </SettingsGroup>

    </>
  );
}

/** The "Thread" card of Display → Thread: how the conversation itself reads. Every toggle
 *  here is a GLOBAL default — e.g. "clean output" folds each round's work behind a "Work"
 *  block, and a conversation's composer chip can still override its own. Rendered above
 *  the Markdown card (`ConversationSection`), which is the same subject. */
function ThreadPrefs() {
  const cleanOutput = useDisplay((s) => s.cleanOutput);
  const showTaskNotifications = useDisplay((s) => s.showTaskNotifications);
  const showLastMessagePreview = useDisplay((s) => s.showLastMessagePreview);
  const messageMinimap = useDisplay((s) => s.messageMinimap);
  const minimapHoverMode = useDisplay((s) => s.minimapHoverMode);
  const messageControls = useDisplay((s) => s.messageControls);
  const clickableFileMentions = useDisplay((s) => s.clickableFileMentions);
  const set = useDisplay((s) => s.set);
  return (
    <>
      <SettingsGroup title="Thread" icon="chat">
        <ToggleRow
          title="Clean output (default)"
          hint={
            <>
              Shows only the final message of each response; tools, thinking, and intermediate
              steps are folded behind a "Work" block that expands on demand.{" "}
              <strong>Default</strong> setting: each conversation can override it via its
              "Clean output" button.
            </>
          }
          checked={cleanOutput}
          onChange={(v) => set({ cleanOutput: v })}
          label="Clean output by default"
        />
        <ToggleRow
          title="Background task notifications"
          hint={
            <>
              Shows <code>&lt;task-notification&gt;</code> messages (injected by the CLI when a
              background task or sub-agent finishes) in the thread. <strong>Off by
              default</strong>: they clutter the conversation, especially on reload or when importing
              from history.
            </>
          }
          checked={showTaskNotifications}
          onChange={(v) => set({ showTaskNotifications: v })}
          label="Show background task notifications"
        />
        <ToggleRow
          title="Preview of the last sent message"
          hint={
            <>
              Pins a <strong>floating</strong> preview of the last message you sent to the top of the
              conversation (the message itself if short, otherwise a brief summary) — the same one
              shown on the Flight Deck. Clicking it <strong>scrolls</strong> to the message.{" "}
              <strong>On by default.</strong>
            </>
          }
          checked={showLastMessagePreview}
          onChange={(v) => set({ showLastMessagePreview: v })}
          label="Preview of the last sent message"
        />
        <ToggleRow
          title="Message minimap"
          hint={
            <>
              Adds a compact block of thin marks at the <strong>right edge</strong> of the
              conversation — one per message you sent. <strong>Hovering</strong> one previews that
              message, <strong>clicking</strong> it scrolls to it, and the mark of the message
              you're reading stays lit. The whole conversation always fits: on a long thread the
              marks tighten instead of scrolling. <strong>On by default</strong>; hidden below two
              messages.
            </>
          }
          checked={messageMinimap}
          onChange={(v) => set({ messageMinimap: v })}
          label="Show the message minimap"
        />
        {messageMinimap ? (
          <div className={styles.modeBlock}>
            <div className={styles.ttitle}>Minimap hover</div>
            <OptionCardRail
              options={MINIMAP_HOVER_MODES}
              selected={minimapHoverMode}
              onSelect={(id) => set({ minimapHoverMode: id })}
              ariaLabel="Message minimap hover preview"
            />
            <div className={styles.note}>
              Summaries are the ones already generated when each message was sent, and are kept
              from one run to the next. Messages that never got one — short messages and slash
              commands, where the text is already its own summary — show their first line.
            </div>
          </div>
        ) : null}
        <ToggleRow
          title="Message controls"
          hint={
            <>
              Shows controls on hover over messages (yours and Claude's):
              <strong> "resume from here"</strong> (rewinds the conversation to that point) and
              <strong> "fork"</strong> (branches a new conversation from that point).{" "}
              <strong>On by default.</strong>
            </>
          }
          checked={messageControls}
          onChange={(v) => set({ messageControls: v })}
          label="Show message controls"
        />
        <ToggleRow
          title="Clickable filename on Read/Write rows"
          hint={
            <>
              On a <strong>Read/Write/Edit</strong> row, makes the filename{" "}
              <strong>open the file</strong> instead of just expanding the row.{" "}
              <strong>On by default.</strong> Off → the row only expands; the file stays one click
              away from the filename above its snippet. Paths elsewhere (text, links, snippet
              headers) are always clickable.
            </>
          }
          checked={clickableFileMentions}
          onChange={(v) => set({ clickableFileMentions: v })}
          label="Make the filename on Read/Write rows clickable"
        />
      </SettingsGroup>

    </>
  );
}

/** The "Motion" card of Display → Appearance: the optional animations, each of which the
 *  system's "reduce motion" always overrides. */
function MotionPrefs() {
  const flightdeckModalZoom = useDisplay((s) => s.flightdeckModalZoom);
  const panelAnimations = useDisplay((s) => s.panelAnimations);
  const conversationAnimations = useDisplay((s) => s.conversationAnimations);
  const set = useDisplay((s) => s.set);
  return (
    <>
      <SettingsGroup title="Motion" icon="play">
        <ToggleRow
          title="Zoom when opening a card"
          hint={
            <>
              On the Flight Deck, opening a card makes the conversation{" "}
              <strong>grow out of that card</strong> and shrink back into it when closed — like
              Finder's Quick Look. <strong>On by default</strong> (about a fifth of a second).
              Off → the conversation appears and disappears instantly. Your system's{" "}
              <strong>"reduce motion"</strong> setting always wins over this.
            </>
          }
          checked={flightdeckModalZoom}
          onChange={(v) => set({ flightdeckModalZoom: v })}
          label="Zoom the conversation out of its card"
        />
        <ToggleRow
          title="Slide side panels open"
          hint={
            <>
              A side panel <strong>pushes its way in</strong> from the edge and the view beside
              it gives way over the same fraction of a second, instead of the layout jumping in
              one frame. Covers the conversation's <strong>editor, terminal, artifact viewer</strong>{" "}
              and task panel, and the <strong>Tasks</strong> view's panel.{" "}
              <strong>On by default</strong> (about a fifth of a second). The panel's contents
              are held at their final size while it travels, so nothing inside re-lays-out on the
              way. Off → panels appear and disappear instantly. Your system's{" "}
              <strong>"reduce motion"</strong> setting always wins over this.
            </>
          }
          checked={panelAnimations}
          onChange={(v) => set({ panelAnimations: v })}
          label="Animate side panels opening and closing"
        />
        <ToggleRow
          title="Animate the conversation"
          hint={
            <>
              A tool section or work block <strong>opens and closes as a movement</strong> rather
              than a cut, and in <strong>clean output</strong> a finished step{" "}
              <strong>slides up into the work block</strong> instead of being swapped between the
              two in one frame. <strong>On by default</strong> (about a tenth of a second).
              Unlike the side panels, this one plays on <strong>every turn</strong>, right where
              you are reading. Off → the thread jumps between states as it did before. Your
              system's <strong>"reduce motion"</strong> setting always wins over this.
            </>
          }
          checked={conversationAnimations}
          onChange={(v) => set({ conversationAnimations: v })}
          label="Animate work folding and unfolding"
        />
      </SettingsGroup>
    </>
  );
}

/** The zoom control of the "Interface zoom" row: −, the current percentage, +, and a Reset
 *  back to 100%. Steps through the shared {@link ZOOM_STEPS} ladder, so clicking here and
 *  pressing ⌘+ land on exactly the same levels.
 *
 *  Reset stays in place (disabled at 100%) rather than appearing only when zoomed: a button
 *  that comes and goes would shift the row's layout on every step. The −/+ buttons disable at
 *  the ends of the ladder for the same reason — the state is visible in the percentage next
 *  to them, so nothing needs a tooltip a disabled control could never show. */
function ZoomStepper({ zoom, onChange }: { zoom: number; onChange: (next: number) => void }) {
  const atMin = zoom <= MIN_ZOOM;
  const atMax = zoom >= MAX_ZOOM;
  return (
    <div className={styles.zoomCtl}>
      <button
        type="button"
        className={styles.zoomBtn}
        onClick={() => onChange(prevZoom(zoom))}
        disabled={atMin}
        aria-label="Zoom out"
      >
        −
      </button>
      <span className={styles.zoomVal} aria-live="polite">
        {formatZoom(zoom)}
      </span>
      <button
        type="button"
        className={styles.zoomBtn}
        onClick={() => onChange(nextZoom(zoom))}
        disabled={atMax}
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        className={styles.zoomReset}
        onClick={() => onChange(DEFAULT_ZOOM)}
        disabled={zoom === DEFAULT_ZOOM}
      >
        Reset
      </button>
    </div>
  );
}

/** Ordering prefs (Display → Order), split so each surface is its own clear section:
 *  the conversation sidebar, the Flight Deck, then whether they share one order. Each toggle
 *  turns the AUTOMATIC reorder on/off for one surface + level. Off = a frozen drag-and-drop
 *  order that never reshuffles on its own (drag a conversation/card anywhere; repos/swimlanes
 *  by their header). New items still appear on top; the order survives quit/relaunch. */
function OrderingPrefs() {
  const autoSidebarConvs = useDisplay((s) => s.autoOrderSidebarConvs);
  const autoSidebarRepos = useDisplay((s) => s.autoOrderSidebarRepos);
  const autoFleetConvs = useDisplay((s) => s.autoOrderFleetConvs);
  const autoFleetRepos = useDisplay((s) => s.autoOrderFleetRepos);
  const sharedOrder = useDisplay((s) => s.sharedManualOrder);
  const set = useDisplay((s) => s.set);
  return (
    <>
      <SettingsGroup title="Conversation order" icon="chat">
        <ToggleRow
          title="Conversations"
          hint={
            <>
              On → most recently active first. Off → the order you set by <strong>dragging</strong>{" "}
              a conversation (anywhere on its row); it never reshuffles on its own and new
              conversations appear on top. <strong>On by default.</strong>
            </>
          }
          checked={autoSidebarConvs}
          onChange={(v) => set({ autoOrderSidebarConvs: v })}
          label="Auto-order sidebar conversations by recency"
        />
        <ToggleRow
          title="Repositories"
          hint={
            <>
              On → by most recent activity. Off → <strong>drag</strong> repositories (by their
              header) into a fixed order. <strong>On by default.</strong>
            </>
          }
          checked={autoSidebarRepos}
          onChange={(v) => set({ autoOrderSidebarRepos: v })}
          label="Auto-order sidebar repositories by recency"
        />
      </SettingsGroup>

      <SettingsGroup title="Flight Deck order" icon="grid">
        <ToggleRow
          title="Cards"
          hint={
            <>
              On → attention first (<strong>status then recency</strong>). Off → the fixed order
              you set by <strong>dragging</strong> a card (anywhere on it); even a card needing
              attention stays put and new ones appear at the start. <strong>On by default.</strong>
            </>
          }
          checked={autoFleetConvs}
          onChange={(v) => set({ autoOrderFleetConvs: v })}
          label="Auto-order Flight Deck cards by status"
        />
        <ToggleRow
          title="Swimlanes"
          hint={
            <>
              On → attention first. Off → <strong>drag</strong> swimlanes (by their header) into a
              fixed order. <strong>On by default.</strong>
            </>
          }
          checked={autoFleetRepos}
          onChange={(v) => set({ autoOrderFleetRepos: v })}
          label="Auto-order Flight Deck swimlanes by status"
        />
      </SettingsGroup>

      <SettingsGroup title="Shared order" icon="link">
        <ToggleRow
          title="Share order between the two views"
          hint={
            <>
              On → the sidebar and the Flight Deck use the <strong>same</strong> manual order
              (dragging in one reorders the other). Off → each view keeps its own arrangement. Only
              affects levels set to manual. <strong>On by default.</strong>
            </>
          }
          checked={sharedOrder}
          onChange={(v) => set({ sharedManualOrder: v })}
          label="Share manual order across sidebar and Flight Deck"
        />
      </SettingsGroup>
    </>
  );
}

/** The timing toggles — one per family of time shown in the conversation, so each can be
 *  hidden on its own. All on by default (see store/display DEFAULTS). */
function TimingPrefs() {
  const showTurnDuration = useDisplay((s) => s.showTurnDuration);
  const showModelTime = useDisplay((s) => s.showModelTime);
  const showThinkingTime = useDisplay((s) => s.showThinkingTime);
  const showToolTime = useDisplay((s) => s.showToolTime);
  const sidebarRowTimer = useDisplay((s) => s.sidebarRowTimer);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Durations & timing" icon="clock">
      <ToggleRow
        title="Time on sidebar rows"
        hint={
          <>
            On a conversation's row in the sidebar, next to the working dots: a{" "}
            <strong>live counter</strong> while the agent works, then the time{" "}
            <strong>frozen</strong> on how long the turn took once it stops on a state
            (ready to review, a question, an error). Off → the dots alone. Needs{" "}
            “Tinted conversation rows” (Appearance). <strong>On by default.</strong>
          </>
        }
        checked={sidebarRowTimer}
        onChange={(v) => set({ sidebarRowTimer: v })}
        label="Show the time on conversation rows"
      />
      <ToggleRow
        title="Turn duration"
        hint={
          <>
            Under each finished turn, the <strong>total time</strong> it took; and a{" "}
            <strong>live counter</strong> when a turn runs past 40&nbsp;s.{" "}
            <strong>On by default.</strong>
          </>
        }
        checked={showTurnDuration}
        onChange={(v) => set({ showTurnDuration: v })}
        label="Show turn duration"
      />
      <ToggleRow
        title="Model time"
        hint={
          <>
            Next to the turn duration, the <strong>time spent on the model side</strong>{" "}
            ("· 18s model"). Visible only if "Turn duration" is on.{" "}
            <strong>On by default.</strong>
          </>
        }
        checked={showModelTime}
        onChange={(v) => set({ showModelTime: v })}
        label="Show model time"
      />
      <ToggleRow
        title="Thinking time"
        hint={
          <>
            On each thinking block, the time spent thinking — a{" "}
            <strong>live counter</strong> during thinking, then frozen.{" "}
            <strong>On by default.</strong>
          </>
        }
        checked={showThinkingTime}
        onChange={(v) => set({ showThinkingTime: v })}
        label="Show thinking time"
      />
      <ToggleRow
        title="Tool time"
        hint={
          <>
            On each tool (Read, Bash, Edit…), its <strong>run time</strong> — a
            live counter while it runs, then frozen.{" "}
            <strong>On by default.</strong>
          </>
        }
        checked={showToolTime}
        onChange={(v) => set({ showToolTime: v })}
        label="Show tool time"
      />
    </SettingsGroup>
  );
}

/** The two independent toggles for the "Fleet readout" banner — the adaptive stage
 *  counts ("N Running · N Review · …") across the whole fleet. One controls the wide
 *  bar at the top of the FlightDeck, the other the compact box at the bottom of the
 *  conversation sidebar; they're deliberately separate so either surface can be hidden
 *  on its own. Both on by default (see store/display DEFAULTS). */
function FleetBannerPrefs() {
  const flightDeck = useDisplay((s) => s.fleetBannerFlightDeck);
  const conversation = useDisplay((s) => s.fleetBannerConversation);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Fleet banner" icon="grid">
      <ToggleRow
        title="Show in the Flight Deck"
        hint="The fleet readout (Running · Review · Need Attention · Idle) at the top of the Flight Deck."
        checked={flightDeck}
        onChange={(v) => set({ fleetBannerFlightDeck: v })}
        label="Fleet banner in the Flight Deck"
      />
      <ToggleRow
        title="Show in the Conversation"
        hint="The same readout, in a compact version, at the bottom of the conversation sidebar."
        checked={conversation}
        onChange={(v) => set({ fleetBannerConversation: v })}
        label="Fleet banner in the Conversation"
      />
    </SettingsGroup>
  );
}

/** Background-task behaviour toggles. Today: re-alert at a clean turn end when the sole
 *  background work still running is a background Bash command (see store/display
 *  `alertOnBackgroundBash`). Off by default — a lone background Bash command otherwise stays
 *  in the silent green `backgrounding` state like every other background tool. */
function BackgroundTaskPrefs() {
  const alertOnBackgroundBash = useDisplay((s) => s.alertOnBackgroundBash);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Background tasks" icon="term">
      <ToggleRow
        title="Alert for background shell commands"
        hint={
          <>
            At the end of a turn, if the <strong>only</strong> background task still running is a
            Bash command launched in the background, fires a notification and moves the conversation
            to <strong>"to review"</strong> (blue) instead of the silent green state. Once the
            conversation is marked as seen, it returns to green "background task" while the command
            runs. Sub-agents and workflows keep the green state.{" "}
            <strong>Off by default.</strong>
          </>
        }
        checked={alertOnBackgroundBash}
        onChange={(v) => set({ alertOnBackgroundBash: v })}
        label="Alert for background shell commands"
      />
    </SettingsGroup>
  );
}

/** Permission prefs (Claude Code → Behavior): unlock "Bypass permissions" as a mode a
 *  conversation may be switched to. The unlock is a SPAWN flag
 *  (`--allow-dangerously-skip-permissions`), so it only reaches sessions started after
 *  it — the composer's menu says so when a running session can't honour it.
 *
 *  Turning it off demotes every conversation still in Bypass back to Default, live ones
 *  included: withdrawing the permission has to bite immediately, not at the next spawn. */
function PermissionPrefs() {
  const allowBypass = usePermissionPrefs((s) => s.allowBypassPermissions);
  const set = usePermissionPrefs((s) => s.set);
  return (
    <SettingsGroup title="Permissions" icon="shield">
      <ToggleRow
        title="Allow Bypass permissions mode"
        hint={
          <>
            Makes <strong>Bypass permissions</strong> selectable in a conversation's permission
            menu. In that mode the agent runs every tool — edits, shell commands, network calls —{" "}
            <strong>without ever asking</strong>. Unlocking is not enabling: nothing changes until
            a conversation is explicitly switched to it, and only conversations started afterwards
            can use it (restart a running one). Turning this back off returns every conversation
            still in Bypass to <strong>Default</strong> right away. <strong>Off by default.</strong>
          </>
        }
        checked={allowBypass}
        onChange={(v) => {
          set({ allowBypassPermissions: v });
          if (!v) demoteBypassConversations();
        }}
        label="Allow Bypass permissions mode"
      />
    </SettingsGroup>
  );
}

const CAFFEINATE_MODES: Array<{ id: CaffeinateMode; label: string; desc: string }> = [
  {
    id: "light",
    label: "Light — follow the agents",
    desc: "Keeps the Mac awake only while an agent is working — a running turn or a background task. Once the whole fleet has been idle for a minute, the Mac is free to sleep — the minute lets an agent pick its work back up after a background task finishes. The everyday mode: it never keeps the Mac awake needlessly.",
  },
  {
    id: "hard",
    label: "Hard — always awake",
    desc: "Keeps the Mac awake permanently while Caffeinate is on, even when nothing is running — for Scheduled Tasks that may fire while the fleet is idle. Released only when you turn Caffeinate off.",
  },
];

/** Caffeinate prefs (General → System): arm/disarm "keep the Mac awake" (same store as the
 *  title-bar coffee button) and pick the mode. The mode selector spells out what Light vs
 *  Hard actually do, since the labels alone aren't self-explanatory. */
function CaffeinatePrefs() {
  const enabled = useCaffeinate((s) => s.enabled);
  const mode = useCaffeinate((s) => s.mode);
  const set = useCaffeinate((s) => s.set);
  const toggle = useCaffeinate((s) => s.toggleEnabled);
  return (
    <SettingsGroup title="Caffeinate" icon="coffee">
      <ToggleRow
        title="Keep the Mac awake"
        hint={
          <>
            Prevents the Mac from sleeping while agents work (long or background runs) and for
            Scheduled Tasks. The screen may still turn off or lock — only the machine stays awake.
            Same switch as the <strong>coffee button</strong> in the title bar.{" "}
            <strong>Off by default.</strong>
          </>
        }
        checked={enabled}
        onChange={() => toggle()}
        label="Caffeinate"
      />
      <div className={styles.modeBlock}>
        <div className={styles.ttitle}>Mode</div>
        <OptionCardRail
          options={CAFFEINATE_MODES}
          selected={mode}
          onSelect={(id) => set({ mode: id })}
          ariaLabel="Caffeinate mode"
        />
        <div className={styles.note}>
          Both modes use the same anti-sleep flag; they differ only in how long it's held.
          Caffeinate can't keep the Mac awake with the <strong>lid closed</strong> (macOS treats a
          lid close as sleep), so leave the lid open for overnight Scheduled Tasks.
        </div>
      </div>
    </SettingsGroup>
  );
}
