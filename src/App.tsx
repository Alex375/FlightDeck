import { useCallback, useEffect, useRef, useState } from "react";
import { ConductorConversation } from "./features/conversation/ConductorConversation";
import { OpenInTerminalButton } from "./features/conversation/OpenInTerminalButton";
import { TerminalToggle } from "./features/conversation/TerminalToggle";
import { StreamControl } from "./features/conversation/StreamControl";
import { WorktreeIndicator } from "./features/git/WorktreeIndicator";
import { WorktreeManager } from "./features/git/WorktreeManager";
import { GitToggle } from "./features/git/GitToggle";
import { EditorToggle } from "./features/editor/EditorToggle";
import { FlightDeck } from "./features/flightdeck/FlightDeck";
import { FlightDeckReplyModal } from "./features/flightdeck/FlightDeckReplyModal";
import { useFlightdeckModal } from "./features/flightdeck/flightdeckModalStore";
import { SoundToggle } from "./features/notifications/SoundToggle";
import { CaffeinateToggle } from "./features/power/CaffeinateToggle";
import { CaffeinateHost } from "./features/power/CaffeinateHost";
import { ZoomHost } from "./ui/ZoomHost";
import { WorkflowWatchHost } from "./features/conversation/WorkflowWatchHost";
import { ExtensionsManager } from "./features/extensions/ExtensionsManager";
import { TosseRepoCard } from "./features/tosse/TosseRepoCard";
import { TosseView } from "./features/tosse/TosseView";
import { TosseLiveHost } from "./features/tosse/TosseLiveHost";
import { TosseTaskChip } from "./features/tosse/TosseTaskChip";
import { LinkedTaskSync } from "./features/tosse/LinkedTaskSync";
import { useTosseConnection } from "./ipc/useTosse";
import { HistoryPanel } from "./features/history/HistoryPanel";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { useEditorStore } from "./features/editor/editorStore";
import { UltraCodeBlast } from "./features/conversation/UltraCodeBlast";
import { UpdateBanner } from "./features/settings/UpdateBanner";
import { ClaudeCliBanner } from "./features/settings/ClaudeCliBanner";
import { AppErrorBanner } from "./ui/AppErrorBanner";
import { useGlobalSessionEvents } from "./ipc/useGlobalSessionEvents";
import { AppControlHost } from "./agent/AppControlHost";
import { VoiceHost } from "./voice/VoiceHost";
import { VoiceMicToggle, VoiceModeToggle } from "./voice/VoiceToggle";
import { startUpdaterAutoCheck } from "./store/updater";
import { startClaudeCliAutoCheck } from "./store/claudeCliUpdate";
import { initNotifications } from "./notifications/notify";
import { primeAudioUnlock } from "./notifications/sound";
import {
  bootConversations,
  useActiveConversationId,
  useConversationRepo,
  useConversations,
  useConversationsStore,
} from "./store/conversationsStore";
import { useDisplay } from "./store/display";
import { useNotifications } from "./store/notifications";
import { useSettingsUi } from "./store/settingsUi";
import { NavBtn, TosseCrmMark, Win } from "./ui/kit";
import { runAppAction } from "./ui/appActions";
import {
  ACTION_BINDINGS,
  isEditableTarget,
  isSettingsChord,
  isSoundToggleChord,
  isUndoChord,
  matchChord,
  viewForShortcut,
  type View,
} from "./ui/shortcuts";

export default function App() {
  useGlobalSessionEvents();
  const [view, setView] = useState<View>("conversation");
  const conversations = useConversations();
  const activeId = useActiveConversationId();
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeRepo = useConversationRepo(activeId);
  const booted = useRef(false);
  // Live mirror of the current view, read inside the (deps-light) keydown handler so
  // conversation-scoped shortcuts (⌘B/⌘J/…) can tell whether we're on the deck without
  // re-subscribing the listener on every view change.
  const viewRef = useRef(view);
  viewRef.current = view;

  // The reply modal lives ONLY on the Flight Deck. Switch views through `changeView`
  // so leaving the deck dismisses it SYNCHRONOUSLY (not in a post-render effect): the
  // modal store's convId stays consistent with the view at all times, so an async
  // agent notification landing mid-transition can never read a stale "watched" conv
  // (see notify.ts). It also keeps the same conversation from being mounted twice
  // (modal + full view) at once.
  const closeReplyModal = useFlightdeckModal((s) => s.close);

  // Settings is mounted here rather than in the sidebar, so ⌘, works from every view.
  const settingsOpen = useSettingsUi((s) => s.open);
  const closeSettings = useSettingsUi((s) => s.closeSettings);

  // The TOSSE tab is CONDITIONAL — it exists only while signed in to the CRM (and while the
  // display preference keeps it on). Signed out we show no tab at all rather than an empty
  // shell, which is the whole point: the app is fully usable without TOSSE. Passing the
  // preference as `enabled` means switching the feature off costs nothing either — the
  // status query never runs.
  const tosseTabEnabled = useDisplay((s) => s.tosseTasksView);
  const { data: tosseConnection } = useTosseConnection(tosseTabEnabled);
  const tosseAvailable = tosseTabEnabled && tosseConnection?.connected === true;

  const changeView = useCallback(
    (next: View) => {
      // A view that isn't currently available is a no-op, not a blank screen: ⌘3 while
      // signed out must leave you where you are.
      if (next === "tosse" && !tosseAvailable) return;
      if (next !== "flightdeck") closeReplyModal();
      setView(next);
    },
    [closeReplyModal, tosseAvailable],
  );

  // Signing out (or switching the feature off) while the TOSSE view is open must not strand
  // the window on a view that no longer exists — fall back to the deck.
  useEffect(() => {
    if (view === "tosse" && !tosseAvailable) setView("flightdeck");
  }, [view, tosseAvailable]);
  // Defensive backstop: if a view change ever bypasses `changeView`, still close the
  // modal on leaving the deck (post-render, so it can lag — `changeView` is the
  // race-free path every current caller uses).
  useEffect(() => {
    if (view !== "flightdeck") closeReplyModal();
  }, [view, closeReplyModal]);

  // Focusing an agent from the FlightDeck = select it and switch to its thread. Also
  // used to PROMOTE the reply modal to the full view (its "Fullscreen" button).
  const openConversation = (id: string) => {
    useConversationsStore.getState().selectConversation(id);
    changeView("conversation");
  };

  // On first mount: hydrate from the core's persisted state. Lazy policy — boot
  // spawns nothing; a conversation's history loads when it's shown and its
  // process starts on the first message. An empty store stays empty.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootConversations();
    // Check for app updates now and every 2h while open (idempotent).
    startUpdaterAutoCheck();
    startClaudeCliAutoCheck();
    // Prime OS notification permission so the first agent notification doesn't
    // race a permission prompt, and unlock audio on the first user gesture so a
    // background chime isn't blocked by the webview's autoplay policy.
    void initNotifications();
    primeAudioUnlock();
  }, []);

  // ⌘/Ctrl+1 → Conversation, ⌘/Ctrl+2 → Flight Deck. Works from anywhere (even the
  // composer): ⌘+digit never types a character, so it won't clash with editing. The
  // physical-key / modifier logic lives in `viewForShortcut` (pure + unit-tested).
  // ⌘/Ctrl+, opens Settings (the macOS-standard Preferences chord).
  // ⌘/Ctrl+Z restores the last conversation deleted via its × (the no-confirm delete's
  // undo) — but ONLY when focus isn't in a control with its own undo (composer, Monaco,
  // rename input, terminal), so we never steal their Z. All decisions are pure helpers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = viewForShortcut(e);
      if (target) {
        e.preventDefault();
        changeView(target);
        return;
      }
      // ⌘⇧M toggles the notification sound (mute/unmute the chime on the spot). A
      // distinct chord that never types a character, so it fires app-wide without
      // the editable-target guard — see `isSoundToggleChord`.
      if (isSoundToggleChord(e)) {
        e.preventDefault();
        useNotifications.getState().toggleSound();
        return;
      }
      // ⌘, opens the Settings panel — the macOS-standard Preferences shortcut. Like the
      // other chords it never types a character, so it fires app-wide without an
      // editable-target guard. Decision lives in the pure `isSettingsChord` helper.
      if (isSettingsChord(e)) {
        e.preventDefault();
        useSettingsUi.getState().openSettings();
        return;
      }
      if (isUndoChord(e) && !isEditableTarget(document.activeElement)) {
        // Only consume the key if something was actually restored, so an empty undo
        // stack leaves any other ⌘Z handling untouched.
        if (useConversationsStore.getState().undoRemoveConversation()) e.preventDefault();
        return;
      }
      // The rest of the app-action chords (toggle panels, new/nav conversation,
      // extensions, history) are driven from the shared ACTION_BINDINGS table so the
      // Settings → Raccourcis page documents exactly what's wired. Conversation-scoped
      // ones are inert off the conversation view; global ones fire anywhere. Like the
      // chords above, ⌘+key never types a character, so they win over the editor.
      for (const b of ACTION_BINDINGS) {
        if (!matchChord(e, b.spec)) continue;
        if (b.scope === "conversation" && viewRef.current !== "conversation") return;
        if (runAppAction(b.action, { changeView })) e.preventDefault();
        return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeView]);

  // Claim Escape for the app so it never makes macOS exit NATIVE fullscreen (the OS
  // default when a keydown reaches AppKit unhandled). This is the SINGLE authority for
  // that: we preventDefault UNCONDITIONALLY (Monaco/xterm excepted — they own their
  // Escape), in CAPTURE phase so it lands as early as possible in the dispatch. We
  // never stopPropagation, so every overlay/menu still receives Escape and closes.
  //
  // Because this always sets `defaultPrevented`, overlays must NOT gate their close on
  // it (that signal is now ours). The one-Escape-closes-one-layer ordering is instead
  // enforced by the nested drill-in popovers calling `stopPropagation()` — so an outer
  // window-level modal simply doesn't receive the key when an inner popover consumed it.
  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      if (el && el.closest(".monaco-editor, .xterm")) return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);

  return (
    <Win
      title={
        view === "flightdeck"
          ? "Flight Deck"
          : view === "tosse"
            ? "TOSSE"
            : active?.name ?? "Conductor"
      }
      banner={<><UpdateBanner /><ClaudeCliBanner /><AppErrorBanner /></>}
      nav={
        <>
          <NavBtn
            icon="chat"
            label="Conversation"
            on={view === "conversation"}
            title="Conversation (⌘1)"
            onClick={() => changeView("conversation")}
          />
          <NavBtn
            icon="grid"
            label="Flight Deck"
            on={view === "flightdeck"}
            title="Flight Deck (⌘2)"
            onClick={() => changeView("flightdeck")}
          />
          {/* Only while signed in to TOSSE — no tab rather than an empty one. */}
          {tosseAvailable ? (
            <NavBtn
              glyph={<TosseCrmMark className="sm" />}
              label="TOSSE"
              on={view === "tosse"}
              title="TOSSE tasks (⌘3)"
              onClick={() => changeView("tosse")}
            />
          ) : null}
        </>
      }
      right={
        <>
          {/* Always visible (both views): mute/unmute the notification chime on the
              spot, without opening Settings. Also bound to ⌘⇧M. */}
          {/* Voice agent: arm/disarm the session, then open/close the mic within
              it. Both render nothing until an OpenAI key is configured. */}
          <VoiceModeToggle />
          <VoiceMicToggle />
          <SoundToggle />
          {/* Always visible (both views): arm/disarm Caffeinate (keep the Mac awake). */}
          <CaffeinateToggle />
          {view === "conversation" && activeRepo ? (
            <>
              {/* Which TOSSE task this conversation carries. Only for a conversation
                  started from the tasks view; a click goes back to it. */}
              {active && tosseAvailable ? (
                <TosseTaskChip
                  conv={active}
                  // Reads in the side panel rather than switching views: you are working IN
                  // this conversation, and going to look at the task should not take the
                  // conversation off screen.
                  onOpen={() =>
                    useEditorStore
                      .getState()
                      .openTosseTask({ convId: active.id, taskId: active.tosseTaskId! })
                  }
                />
              ) : null}
              {active ? <WorktreeIndicator conv={active} repoPath={activeRepo.path} /> : null}
              {active ? <StreamControl key={active.id} conv={active} /> : null}
              {active ? <EditorToggle /> : null}
              {active ? <TerminalToggle /> : null}
              {active ? <GitToggle /> : null}
              {active ? (
                <OpenInTerminalButton
                  sessionId={active.sessionId}
                  cwd={active.cwd}
                  backend={active.kind}
                />
              ) : null}
            </>
          ) : null}
        </>
      }
    >
      {view === "conversation" ? (
        <ConductorConversation active={active} />
      ) : view === "tosse" ? (
        <TosseView onOpenConversation={openConversation} />
      ) : (
        <FlightDeck onOpen={openConversation} />
      )}
      {/* Reply-in-place modal over the Flight Deck (store-driven, opened by a card's
          attention action). Gated on the view so it can't overlay the Conversation
          view or double-mount a conversation already shown there. */}
      {view === "flightdeck" ? <FlightDeckReplyModal onPromote={openConversation} /> : null}
      {/* Mounted once, globally: opens for whichever repo the indicator/badge asks. */}
      <WorktreeManager />
      {/* Idem: the extensions manager, opened per repo (sidebar) or per conversation (composer). */}
      <ExtensionsManager />
      {/* Idem: the TOSSE card of a repository, opened by the mark on its sidebar header. */}
      <TosseRepoCard />
      {/* Idem: the conversation-history search panel, opened from the sidebar search bar. */}
      <HistoryPanel />
      {/* Idem: Settings. Global rather than inside the sidebar, because ⌘, is a GLOBAL chord
          (the shortcuts catalogue lists it as one) — mounted in the sidebar it did nothing
          from the Flight Deck or the TOSSE view, silently leaving the store "open". */}
      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
      {/* Mounted once, globally: the full-screen "Ultra code" activation blast. */}
      <UltraCodeBlast />
      {/* Mounted once, globally (render-null): drives the macOS keep-awake assertion from
          the Caffeinate toggle + mode + live fleet activity. */}
      <CaffeinateHost />
      {/* Idem (render-null): executes the app-control tool calls bridged from the
          app-hosted MCP servers (agents piloting the app). Mounted HERE so it can
          drive the view, like the keyboard shortcuts. */}
      <AppControlHost changeView={changeView} tosseAvailable={tosseAvailable} />
      {/* Idem (render-null): the voice agent's helpers + announcement drain. */}
      <VoiceHost changeView={changeView} tosseAvailable={tosseAvailable} />
      {/* Idem (render-null): keeps each linked conversation's copy of its TOSSE task in step
          with the CRM, so the delete warning stops asking about tasks that are already done. */}
      <LinkedTaskSync />
      {/* Idem (render-null): pushes the interface-zoom preference to the OS webview, on
          mount and on every change. */}
      <ZoomHost />
      {/* Mounted once, globally (render-null): one live disk watch per RUNNING workflow, so
          every surface sees its real per-agent progress even with the detail modal closed. */}
      <WorkflowWatchHost />
      {/* Idem (render-null): the ONE live connection to the CRM's change feed, so the tasks
          view follows a task edited in the browser instead of waiting out a cache delay.
          App-global on purpose — a per-view subscription would open and close the socket
          with the tab. Off unless connected AND the preference is on. */}
      <TosseLiveHost />
    </Win>
  );
}
