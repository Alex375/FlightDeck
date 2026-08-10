// Settings modal — a left-rail tabbed panel (built to scale as more settings
// land). Sections: General (about), Notifications, Updates, Data (the
// destructive "drop all", kept while the SQL model is still in flux). The active
// section is shared state so deep-links (e.g. the update banner) can open it
// straight onto a given tab.
import { useEffect, useState, type ReactNode } from "react";
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
import { AccountsSection } from "./AccountsSection";
import { TosseSection } from "./TosseSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { ComposerSection } from "./ComposerSection";
import { OptionCardRail, PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

// `mark` overrides `icon` for a tab that carries a BRAND logo rather than a kit glyph —
// the rest of the rail stays on the shared icon set.
const TABS: Array<{ id: SettingsSection; label: string; icon: string; mark?: ReactNode }> = [
  { id: "general", label: "General", icon: "cog" },
  { id: "accounts", label: "Accounts", icon: "key" },
  // TOSSE sits next to Accounts (both are "connect to a service") but stays its own tab:
  // Accounts signs the AGENTS in to their model providers, this signs YOU in to the CRM.
  { id: "tosse", label: "TOSSE", icon: "list", mark: <TosseCrmMark className="sm" /> },
  { id: "conversation", label: "Conversation", icon: "chat" },
  // Its own tab rather than a group under General: arranging the bar is a task with a
  // preview and a drag surface, not a row of switches.
  { id: "composer", label: "Composer", icon: "wand" },
  { id: "reordering", label: "Reordering", icon: "reorder" },
  { id: "shortcuts", label: "Shortcuts", icon: "key" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "updates", label: "Updates", icon: "refresh" },
  { id: "data", label: "Data", icon: "trash" },
];

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const section = useSettingsUi((s) => s.section);
  const setSection = useSettingsUi((s) => s.setSection);
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
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

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
          <button className={styles.close} onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.layout}>
          <nav className={styles.rail} aria-label="Settings sections">
            <div className={styles.railCap}>Settings</div>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.railItem}
                data-on={section === t.id ? "" : undefined}
                onClick={() => setSection(t.id)}
              >
                {t.mark ?? <Ico name={t.icon} className="sm" />}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {section === "general" && (
              <div>
                <PageHead title="General" subtitle="Appearance, fleet, and app alerts." />

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

                <DisplayPrefs />
                <TimingPrefs />
                <FleetBannerPrefs />
                <BackgroundTaskPrefs />
                <PermissionPrefs />
                <CaffeinatePrefs />
              </div>
            )}

            {section === "accounts" && <AccountsSection />}

            {section === "tosse" && <TosseSection />}

            {section === "conversation" && <ConversationSection />}

            {section === "composer" && <ComposerSection />}

            {section === "reordering" && (
              <div>
                <PageHead
                  title="Reordering"
                  subtitle="Freeze the automatic order and arrange conversations, cards and repositories by hand — drag them into place."
                />
                <OrderingPrefs />
              </div>
            )}

            {section === "shortcuts" && <ShortcutsSection />}

            {section === "notifications" && <NotificationsSection />}

            {/* Two updaters, one tab: the app itself, then the `claude` binary it drives.
                One page heading covers both — each has its own titled card below. */}
            {section === "updates" && (
              <div>
                <PageHead
                  title="Updates"
                  subtitle="Flight Deck and the Claude Code CLI it drives."
                />
                <UpdateSection />
                <ClaudeCliSection />
              </div>
            )}

            {section === "data" && (
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

/** Display prefs in the General tab. Today: the GLOBAL DEFAULT for "clean output" — fold
 *  each round's work behind a "Work" block so only the final message stays in
 *  clear. This is the default applied to conversations that haven't set their own choice;
 *  each conversation's composer chip can override it (per-conversation, persisted). */
function DisplayPrefs() {
  const uiZoom = useDisplay((s) => s.uiZoom);
  const cleanOutput = useDisplay((s) => s.cleanOutput);
  const showTaskNotifications = useDisplay((s) => s.showTaskNotifications);
  const showLastMessagePreview = useDisplay((s) => s.showLastMessagePreview);
  const messageMinimap = useDisplay((s) => s.messageMinimap);
  const minimapHoverMode = useDisplay((s) => s.minimapHoverMode);
  const workflowLiveCard = useDisplay((s) => s.workflowLiveCard);
  const flightdeckModalZoom = useDisplay((s) => s.flightdeckModalZoom);
  const messageControls = useDisplay((s) => s.messageControls);
  const clickableFileMentions = useDisplay((s) => s.clickableFileMentions);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Display" icon="list">
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

/** Ordering prefs (the "Reordering" tab), split so each surface is its own clear section:
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
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Durations & timing" icon="clock">
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

/** Permission prefs in the General tab: unlock "Bypass permissions" as a mode a
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
    desc: "Keeps the Mac awake only while an agent is working — a running turn or a background task. As soon as the whole fleet is idle, the Mac is free to sleep. The everyday mode: it never keeps the Mac awake needlessly.",
  },
  {
    id: "hard",
    label: "Hard — always awake",
    desc: "Keeps the Mac awake permanently while Caffeinate is on, even when nothing is running — for Scheduled Tasks that may fire while the fleet is idle. Released only when you turn Caffeinate off.",
  },
];

/** Caffeinate prefs in the General tab: arm/disarm "keep the Mac awake" (same store as the
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
