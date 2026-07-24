// Settings modal — a left-rail tabbed panel (built to scale as more settings
// land). Sections: General (about), Notifications, Updates, Data (the
// destructive "drop all", kept while the SQL model is still in flux). The active
// section is shared state so deep-links (e.g. the update banner) can open it
// straight onto a given tab.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { wipeAllData } from "../../store/conversationsStore";
import { useSettingsUi, type SettingsSection } from "../../store/settingsUi";
import { useDisplay } from "../../store/display";
import { useCaffeinate, type CaffeinateMode } from "../../store/caffeinate";
import { Ico } from "../../ui/kit";
import { TosseMark } from "../../ui/TosseMark";
import { UpdateSection } from "./UpdateSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConversationSection } from "./ConversationSection";
import { AccountsSection } from "./AccountsSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { OptionCardRail, PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

const TABS: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: "general", label: "General", icon: "cog" },
  { id: "accounts", label: "Accounts", icon: "key" },
  { id: "conversation", label: "Conversation", icon: "chat" },
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
                <Ico name={t.icon} className="sm" />
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
                <CaffeinatePrefs />
              </div>
            )}

            {section === "accounts" && <AccountsSection />}

            {section === "conversation" && <ConversationSection />}

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

            {section === "updates" && <UpdateSection />}

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

/** Display prefs in the General tab. Today: the GLOBAL DEFAULT for "clean output" — fold
 *  each round's work behind a "Work" block so only the final message stays in
 *  clear. This is the default applied to conversations that haven't set their own choice;
 *  each conversation's composer chip can override it (per-conversation, persisted). */
function DisplayPrefs() {
  const cleanOutput = useDisplay((s) => s.cleanOutput);
  const showTaskNotifications = useDisplay((s) => s.showTaskNotifications);
  const showLastMessagePreview = useDisplay((s) => s.showLastMessagePreview);
  const messageControls = useDisplay((s) => s.messageControls);
  const clickableFileMentions = useDisplay((s) => s.clickableFileMentions);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Display" icon="list">
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
