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
import { ExtensionsManager } from "./features/extensions/ExtensionsManager";
import { TosseRepoCard } from "./features/tosse/TosseRepoCard";
import { useExtensionsUi } from "./features/extensions/extensionsUiStore";
import { HistoryPanel } from "./features/history/HistoryPanel";
import { useHistoryUi } from "./features/history/historyUiStore";
import { useEditorStore } from "./features/editor/editorStore";
import { UltraCodeBlast } from "./features/conversation/UltraCodeBlast";
import { UpdateBanner } from "./features/settings/UpdateBanner";
import { ClaudeCliBanner } from "./features/settings/ClaudeCliBanner";
import { AppErrorBanner } from "./ui/AppErrorBanner";
import { useGlobalSessionEvents } from "./ipc/useGlobalSessionEvents";
import { startUpdaterAutoCheck } from "./store/updater";
import { startClaudeCliAutoCheck } from "./store/claudeCliUpdate";
import { initNotifications } from "./notifications/notify";
import { primeAudioUnlock } from "./notifications/sound";
import {
  bootConversations,
  createConversationInRepo,
  groupConversationsByRepo,
  repoName,
  useActiveConversationId,
  useConversationRepo,
  useConversations,
  useConversationsStore,
} from "./store/conversationsStore";
import { useDisplay, resolveCleanOutput } from "./store/display";
import { useNotifications } from "./store/notifications";
import { useSettingsUi } from "./store/settingsUi";
import { NavBtn, Tag, Win } from "./ui/kit";
import {
  ACTION_BINDINGS,
  isEditableTarget,
  isSettingsChord,
  isSoundToggleChord,
  isUndoChord,
  matchChord,
  viewForShortcut,
  type ShortcutAction,
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
  const changeView = useCallback(
    (next: View) => {
      if (next !== "flightdeck") closeReplyModal();
      setView(next);
    },
    [closeReplyModal],
  );
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
        if (dispatchAction(b.action)) e.preventDefault();
        return;
      }
    }

    /** Run one app-action shortcut; returns whether it did something (so the caller
     *  only swallows the key when it actually acted). Reads live store state at event
     *  time — no stale closures. */
    function dispatchAction(action: ShortcutAction): boolean {
      const store = useConversationsStore.getState();
      const conv = store.conversations.find((c) => c.id === store.activeId) ?? null;
      const editor = useEditorStore.getState();
      switch (action) {
        case "toggle-editor":
          if (!conv) return false;
          editor.toggleOpen();
          return true;
        case "toggle-terminal":
          if (!conv) return false;
          editor.toggleTerminal();
          return true;
        case "toggle-git":
          if (!conv) return false;
          editor.toggleGit();
          return true;
        case "toggle-clean-output": {
          if (!conv) return false;
          const eff = resolveCleanOutput(conv.cleanOutput ?? null, useDisplay.getState().cleanOutput);
          store.setConvCleanOutput(conv.id, !eff);
          return true;
        }
        case "open-extensions":
          if (!conv) return false;
          useExtensionsUi.getState().openManager({
            kind: "conversation",
            backend: conv.kind,
            path: conv.liveCwd ?? conv.cwd ?? ".",
            title: conv.name,
            session: conv.id,
          });
          return true;
        case "new-conversation": {
          const repoPath =
            (conv && store.repos.find((r) => r.id === conv.repoId)?.path) ??
            store.repos[0]?.path ??
            null;
          if (!repoPath) return false;
          createConversationInRepo(repoPath);
          changeView("conversation");
          return true;
        }
        case "prev-conversation":
        case "next-conversation": {
          const ordered = groupConversationsByRepo(store.repos, store.conversations).flatMap(
            (g) => g.conversations,
          );
          if (ordered.length < 2) return false;
          const idx = ordered.findIndex((c) => c.id === store.activeId);
          if (idx < 0) return false;
          const nextIdx = action === "prev-conversation" ? idx - 1 : idx + 1;
          if (nextIdx < 0 || nextIdx >= ordered.length) return false; // clamp at the ends
          store.selectConversation(ordered[nextIdx].id);
          changeView("conversation");
          return true;
        }
        case "open-history":
          useHistoryUi.getState().openPanel();
          return true;
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
      title={view === "flightdeck" ? "Flight Deck" : active?.name ?? "Conductor"}
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
        </>
      }
      right={
        <>
          {/* Always visible (both views): mute/unmute the notification chime on the
              spot, without opening Settings. Also bound to ⌘⇧M. */}
          <SoundToggle />
          {/* Always visible (both views): arm/disarm Caffeinate (keep the Mac awake). */}
          <CaffeinateToggle />
          {view === "conversation" && activeRepo ? (
            <>
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
              <Tag icon="folder" title={activeRepo.path}>
                {repoName(activeRepo.path)}
              </Tag>
            </>
          ) : null}
        </>
      }
    >
      {view === "conversation" ? (
        <ConductorConversation active={active} />
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
      {/* Mounted once, globally: the full-screen "Ultra code" activation blast. */}
      <UltraCodeBlast />
      {/* Mounted once, globally (render-null): drives the macOS keep-awake assertion from
          the Caffeinate toggle + mode + live fleet activity. */}
      <CaffeinateHost />
    </Win>
  );
}
