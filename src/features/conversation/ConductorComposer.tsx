import {
  forwardRef,
  Fragment,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type { PermissionMode, SlashCommand } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";
import type { UserTurnImage } from "../../store/types";
import { isTauri } from "../../ipc/provider";
import { useShallow } from "zustand/react/shallow";
import { useInterrupt, useSendMessage } from "../../ipc/useCommands";
import { useSessionState, useUserMessageHistory } from "../../store/conversationStore";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  useConversationsStore,
} from "../../store/conversationsStore";
import {
  prefetchSlashCommands,
  refetchSlashCommands,
  useSlashCommands,
} from "../../store/commandsStore";
import { useComposerDraft, useComposerDrafts } from "../../store/composerDrafts";
import { useEffectiveCleanOutput } from "../../store/display";
import { useExtensionsUi } from "../extensions/extensionsUiStore";
import { ChipBtn, ClaudeMark, CodexMark, ContextRing, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useClaudeAvailable, useCodexAvailable } from "../../store/binaryAvailable";
import { backendOfModel, modelFamily, modelLabel, modelsForPicker } from "./models";
import { useCodexModels } from "./codexModels";
import { useAccountsLoggedOut } from "../../ipc/useAccounts";
import { useCodexSkills } from "./codexSkills";
import {
  CODEX_PRESETS,
  PRESET_CYCLE,
  PRESET_ORDER,
  useCodexConvControls,
  useCodexControls,
  type CodexPersonality,
  type CodexSummary,
} from "./codexControls";
import { useContextData } from "../../store/contextData";
import { useBackendUsage } from "./backendUsage";
import { useUltraBlast } from "../../store/ultraBlast";
import { EffortGauge, clampEffort, effortLevelsForModel, type EffortLevel } from "./EffortGauge";
import { RemoteControlChip } from "./RemoteControlChip";
import { ArtifactsChip } from "./ArtifactsChip";
import { GoalChip } from "./GoalChip";
import { isGoalCommand, markGoalSeen } from "../../store/goalStore";
import {
  SlashCommandMenu,
  filterSlashCommands,
  isReloadSkillsCommand,
  slashTokenAt,
  type SlashToken,
} from "./SlashCommandMenu";
import {
  IDLE_NAV,
  caretOnFirstLine,
  caretOnLastLine,
  recallNext,
  recallPrev,
  type HistoryNav,
  type RecallResult,
} from "./messageHistory";
import {
  attachmentFromBlob,
  attachmentFromPath,
  attachmentsFor,
  imageDataUrl,
  useComposerAttachments,
  useConvAttachments,
  wireImageMimeForPath,
} from "./composerAttachments";
import styles from "./ConductorComposer.module.css";

// Exact Claude Code permission modes (Shift+Tab selector), in the same order/labels.
// `bypassPermissions` is disabled: the server downgrades it to `default` unless the
// binary is spawned with --allow-dangerously-skip-permissions (not passed yet).
const PERM_OPTS: [string, PermissionMode, boolean?][] = [
  ["Auto mode", "auto"],
  ["Default", "default"],
  ["Auto-accept edits", "acceptEdits"],
  ["Plan mode", "plan"],
  ["Bypass permissions", "bypassPermissions", true],
];
const PERM_LABEL: Record<string, string> = {
  auto: "Auto mode",
  default: "Default",
  acceptEdits: "Auto-accept edits",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Bypass permissions",
};
// Per-mode accent, like the Claude Code terminal: plan=blue, default=gray,
// acceptEdits=purple, auto=yellow, bypass=red. Driven via CSS tokens.
const PERM_TONE: Record<string, string> = {
  auto: "var(--wf-perm-auto)",
  default: "var(--wf-perm-default)",
  acceptEdits: "var(--wf-perm-accept)",
  plan: "var(--wf-perm-plan)",
  bypassPermissions: "var(--wf-perm-bypass)",
  dontAsk: "var(--wf-perm-bypass)",
};
// Modes the user can cycle through with Shift+Tab (bypass is disabled — see PERM_OPTS).
const PERM_CYCLE = PERM_OPTS.filter(([, , disabled]) => !disabled).map(([, value]) => value);

// Codex-only composer options (applied as turn/start overrides). Display labels;
// wire values are the ReasoningSummary / Personality enums.
const CODEX_SUMMARY_OPTS: [string, CodexSummary][] = [
  ["Auto", "auto"],
  ["Concise", "concise"],
  ["Detailed", "detailed"],
  ["None", "none"],
];
const CODEX_PERSONALITY_OPTS: [string, CodexPersonality][] = [
  ["Neutral", "none"],
  ["Friendly", "friendly"],
  ["Pragmatic", "pragmatic"],
];

export interface ComposerHandle {
  /** Focus the message textarea. No-op when it's disabled (read-only session). */
  focus: () => void;
}

export const ConductorComposer = forwardRef<
  ComposerHandle,
  { session: string; onSent?: () => void }
>(function ConductorComposer({ session, onSent }, ref) {
  const state = useSessionState(session);
  const send = useSendMessage(session);
  const interrupt = useInterrupt(session);
  // The unsent draft is NOT component-local state: the conversation pane is keyed by
  // conv.id and remounts on every switch, which would wipe a useState("") and lose
  // what the user was typing. It lives in a per-conversation, localStorage-persisted
  // store instead — so switching away and back keeps the text, and it survives a quit.
  const text = useComposerDraft(session);
  const setText = (v: string) => useComposerDrafts.getState().setDraft(session, v);
  // The controls are NOT component-local state (that would reset on every
  // conversation switch and lie about the stream). DISPLAY source of truth, in
  // order: the LIVE session state while running, else this conversation's persisted
  // record, else the product default. The live session's get_settings/system/init
  // keep the live values honest; the persisted record carries them across (re)spawns.
  const ctl = useConversationsStore(
    useShallow((s) => {
      const c = s.conversations.find((cv) => cv.id === session);
      return {
        model: c?.model ?? null,
        effort: c?.effort ?? null,
        ultracode: c?.ultracode ?? false,
        permissionMode: c?.permissionMode ?? null,
        kind: (c?.kind ?? "claude") as BackendKind,
      };
    }),
  );
  const modelId = state?.model ?? ctl.model ?? DEFAULT_MODEL;
  const effortLevel = (state?.effort ?? ctl.effort ?? DEFAULT_EFFORT) as EffortLevel;
  const ultracodeOn = state?.ultracode ?? ctl.ultracode;
  const gaugeValue: EffortLevel = ultracodeOn ? "ultracode" : effortLevel;
  // "Start this conversation in a fresh worktree" toggle — only meaningful on the
  // FIRST message (before the session spawns); it disappears once spawned.
  const [useWorktree, setUseWorktree] = useState(false);
  const isFresh = useConversationsStore((s) => {
    const c = s.conversations.find((cv) => cv.id === session);
    return !!c && !c.sessionId && !c.handle;
  });
  // Backend awareness for the composer controls. The backend is CHOSEN via the model
  // picker (a Codex model ⇒ a Codex conversation) and FROZEN once the session spawns.
  //  - `backend`: the effective backend of the currently-shown model (drives the chip
  //    mark + which Claude-only controls render).
  //  - `locked`: a message has been sent (session engaged) → the picker can no longer
  //    cross backends, so it only offers the current backend's models.
  const claudeAvailable = useClaudeAvailable();
  const codexAvailable = useCodexAvailable();
  // The backend AUTHORITY is the conversation's committed `kind` — NOT the model id.
  // (A fresh pick flips both together via setConvBackend; and a legacy Codex conv whose
  // persisted model is a Claude alias must still show Codex controls, not Claude ones.)
  const backend = ctl.kind;
  // Locked once a message was sent — INCLUDING while the first send's spawn is still
  // in flight (worktree creation can take seconds; sessionId/handle land only at the
  // end). During that window the actor being started already reads the kind captured
  // at send time, so a cross-backend pick would be refused by the store guard anyway
  // (setConvBackend) — lock the picker so it doesn't offer a dead choice.
  const locked = !isFresh || send.isPending;
  // Dynamic Codex model catalogue (`model/list`), with the verified static fallback —
  // feeds the picker's Codex section AND the data-driven effort gauge.
  const {
    models: codexModels,
    effortsById: codexEfforts,
    tiersById: codexTiers,
    defaultTierById: codexDefaultTier,
  } = useCodexModels(codexAvailable);
  const pickerGroups = modelsForPicker(ctl.kind, { locked, codexAvailable, codexModels });
  // Account state per backend, for the picker's "not connected" badges (definitive
  // logged-out only — cf. useAccountsLoggedOut). Shared cached queries, cost ~nil.
  const loggedOut = useAccountsLoggedOut(claudeAvailable, codexAvailable);
  // Codex-only composer controls (per-conv, localStorage). Read unconditionally (hook
  // rules); only rendered/consumed when the conversation runs on Codex. Model + effort
  // live on the conversation record (shared picker/gauge); these are the Codex-only axes.
  const codexCtl = useCodexConvControls(session);
  // ⇧Tab walks the SAFE presets only (PRESET_CYCLE): "Full access" is excluded from
  // the blind cycle — a stray keystroke must never disarm the sandbox — and stays
  // reachable only through an explicit menu pick, mirroring Claude's PERM_CYCLE
  // excluding bypassPermissions. From danger, ⇧Tab steps back to the safest preset.
  const cyclePreset = () => {
    const i = PRESET_CYCLE.indexOf(codexCtl.preset);
    useCodexControls.getState().set(session, { preset: PRESET_CYCLE[(i + 1) % PRESET_CYCLE.length] });
  };
  const taRef = useRef<HTMLTextAreaElement>(null);

  // ---- Attachments (the "+" button + paste-an-image) ----------------------
  // Joined images for THIS conversation (in-memory, per-conv; see composerAttachments).
  const attachments = useConvAttachments(session);
  // Last attach failure (unreadable / too large / unsupported), shown inline in the
  // attachment row until the next successful attach or send.
  const [attachErr, setAttachErr] = useState<string | null>(null);
  // In-flight pasted-image reads (FileReader is async). While > 0 the send is blocked
  // so a fast paste-then-Enter can't fire BEFORE the image lands (which would send
  // without it, then attach it to the NEXT message).
  const [attaching, setAttaching] = useState(0);

  // ---- Shell-style ↑/↓ history recall -------------------------------------
  // The user's own previously-sent messages, oldest→newest (see selector). The
  // navigation cursor is a ref (no re-render needed) and resets on remount — the
  // pane is keyed by conv.id, so switching conversations starts fresh.
  const history = useUserMessageHistory(session);
  const histNav = useRef<HistoryNav>(IDLE_NAV);

  // Let the conversation view focus the input on a background click (see
  // ConductorConversation). Skips a disabled textarea so a read-only session
  // can't be focused.
  useImperativeHandle(ref, () => ({
    focus: () => {
      const ta = taRef.current;
      if (ta && !ta.disabled) ta.focus();
    },
  }), []);

  // ---- Slash-command autocomplete (the `/` menu) --------------------------
  // Commands are keyed by the conversation's working folder, so the menu works
  // even before the session spawns (typing `/pickup` as the first thing).
  const cwd = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.cwd ?? null,
  );
  const convName = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.name ?? "Conversation",
  );
  const openExtensions = useExtensionsUi((s) => s.openManager);
  // The `/` catalogue is backend-specific: Claude's comes from its `initialize`
  // response (per cwd); Codex's from `skills/list` (fetched only for a Codex conv).
  // Both share the same `SlashCommand` shape + insert/run behaviour (a `/name` in the
  // turn text invokes the skill — verified live on Codex).
  const isCodex = ctl.kind === "codex";
  const claudeCommands = useSlashCommands(cwd);
  const codexSkills = useCodexSkills(isCodex ? cwd : null);
  const commands = isCodex ? codexSkills : claudeCommands;
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashActive, setSlashActive] = useState(0);

  // Load this repo's Claude commands up front (once) so the `/` menu is ready before the
  // first message spawns the session. Skipped for Codex (it has no `claude` initialize;
  // its skills load via `useCodexSkills`), so we never spawn `claude` for a Codex conv.
  useEffect(() => {
    if (!isCodex) void prefetchSlashCommands(cwd);
  }, [cwd, isCodex]);

  const slashMatches = useMemo(
    () => filterSlashCommands(commands, slashToken?.query ?? ""),
    [commands, slashToken?.query],
  );
  const slashOpen = slashToken !== null && !slashDismissed && slashMatches.length > 0;
  // Clamp the active row to the (possibly shrunk) match list.
  const activeIdx = slashMatches.length ? Math.min(slashActive, slashMatches.length - 1) : 0;

  // Reset the highlight to the top whenever the filtered set changes.
  useEffect(() => {
    setSlashActive(0);
  }, [slashToken?.query, commands]);

  // Escape closes the menu. We also grab it at the window level (capture phase)
  // while the menu is open — the OS webview (WKWebView) can swallow Escape inside
  // a focused textarea before React's onKeyDown sees it, so the textarea handler
  // alone isn't reliable. Mirrors how the VS Code extension captures keys while
  // its command menu is open.
  useEffect(() => {
    if (!slashOpen) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [slashOpen]);

  /** Recompute the `/` token from the live textarea (value + caret). */
  const syncSlashToken = (el: HTMLTextAreaElement) => {
    setSlashToken(slashTokenAt(el.value, el.selectionStart ?? el.value.length));
  };

  const busy = state?.busy ?? false;
  // Permission DISPLAY source of truth, in order: live state, persisted record,
  // product default. The generated contract types permission_mode loosely as
  // string; narrow it back to PermissionMode for the helpers below.
  const permMode = (state?.permission_mode ??
    ctl.permissionMode ??
    DEFAULT_PERMISSION_MODE) as PermissionMode;
  const permLabel = PERM_LABEL[permMode] ?? PERM_LABEL[DEFAULT_PERMISSION_MODE];

  // "Clean output" is PER-CONVERSATION: the chip shows this conversation's EFFECTIVE
  // value (its own explicit choice, else the global default from Settings → General)
  // and, on toggle, writes an explicit override for THIS conversation only.
  const cleanOutput = useEffectiveCleanOutput(session);

  // Context fill (ring) — shared derivation keyed by stable id, reused by the
  // FlightDeck card's context bar (see useContextData).
  const { ctx: ctxData, ready: ctxReady, plan: planData } = useContextData(session);

  // Real plan-usage % (account-global, NOT per-conversation) + the compact action.
  // The whole backend-aware wiring (usage source, Forfait label, open/refresh/compact)
  // lives in useBackendUsage, SHARED with the Flight Deck card's context meter
  // (CardContext) so the two surfaces can never drift. Claude's `/compact` rides the
  // composer's own send pipeline (optimistic bubble + scroll-to-bottom); `sendText` is
  // declared below — the closure only runs on click, well after initialization.
  const usage = useBackendUsage(session, {
    enabled: ctxReady,
    compactClaude: () => sendText("/compact"),
  });

  // Every control routes through the conversations store: it persists the choice
  // (so a pre-spawn pick survives and is applied at spawn) AND pushes it to the live
  // stream when running. The live get_settings read-back then confirms reality.
  const choosePerm = (mode: PermissionMode) =>
    useConversationsStore.getState().setConvPermission(session, mode);

  // Shift+Tab cycles the permission mode, like the Claude Code terminal.
  const cyclePermMode = () => {
    const idx = PERM_CYCLE.indexOf(permMode);
    choosePerm(PERM_CYCLE[(idx + 1) % PERM_CYCLE.length]);
  };

  // The blast must play ONLY when Ultra code really turns on — never eagerly on the
  // click. On a re-opened conversation the reset placeholder state (connectingState,
  // ultracode:false) masks the optimistic pick, so the gauge can stay off "ultracode":
  // firing on click there would animate a mode that never activated (blast plays while
  // the slider can't even reach Ultra code). So we only record the INTENT here and let
  // the effect below fire iff activation actually sticks.
  const pendingUltraFireRef = useRef(false);

  const applyEffort = (lvl: EffortLevel) => {
    const store = useConversationsStore.getState();
    // "Ultra code" is not an effort value — it's xhigh + a separate flag.
    if (lvl === "ultracode") {
      if (gaugeValue !== "ultracode") pendingUltraFireRef.current = true;
      store.setConvUltracode(session);
    } else {
      pendingUltraFireRef.current = false; // picking a lower effort cancels the intent
      store.setConvEffort(session, lvl);
    }
  };

  // Never let a pending intent leak across a conversation switch. Declared BEFORE the
  // fire-check on purpose: effects in one commit run in declaration order, so if `session`
  // ever changed under a live instance, the reset lands before the fire-check reads the
  // ref — the blast can't fire for the conversation just switched INTO. (Today the pane is
  // remounted per conversation via `key`, so this is defensive rather than load-bearing.)
  useEffect(() => {
    pendingUltraFireRef.current = false;
  }, [session]);

  // Fire the full-screen blast the moment Ultra code ACTUALLY becomes the active tier
  // after the user asked for it — driven by the same `gaugeValue` the slider reads, so
  // the animation and the slider landing on "ultracode" can never disagree. If the pick
  // doesn't take (masked-placeholder case), the intent stays pending and nothing fires.
  useEffect(() => {
    if (gaugeValue === "ultracode" && pendingUltraFireRef.current) {
      pendingUltraFireRef.current = false;
      useUltraBlast.getState().fire();
    }
  }, [gaugeValue]);

  const chooseModel = (value: string, optionBackend?: BackendKind) => {
    const store = useConversationsStore.getState();
    // The picked option's DECLARED backend is authoritative: the Codex section is fed
    // by the dynamic `model/list` inventory, whose ids owe nothing to our naming
    // heuristics — re-deriving from the id could flip/keep the wrong backend. The
    // `backendOfModel` heuristic remains only for ids arriving WITHOUT an option.
    const nextBackend = optionBackend ?? backendOfModel(value);
    // Picking a model from the OTHER backend on a fresh conversation IS how the
    // backend is chosen: flip kind + model in one shot (the store guards it to the
    // pre-spawn state). Otherwise it's a plain model change on the same backend.
    if (isFresh && nextBackend !== ctl.kind) {
      store.setConvBackend(session, nextBackend, value);
    } else {
      store.setConvModel(session, value);
    }
    // Clamp the effort into what the NEW model supports — for EITHER backend. Switching
    // a fresh Claude conv (effort=max, or Ultra code on) to a Codex model must drop that
    // Claude-only tier to the Codex model's real top (e.g. xhigh), else the gauge shows
    // "low" while buildCodexControls sends an effort the model rejects. Codex uses its
    // data-driven steps (from model/list); Claude derives them from the model id.
    const steps = nextBackend === "codex" ? codexEfforts[value] : undefined;
    const clamped = clampEffort(gaugeValue, value, steps);
    if (clamped !== gaugeValue) applyEffort(clamped);
  };
  const chooseEffort = (lvl: EffortLevel) => applyEffort(lvl);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  // Make an absolute path relative to the conversation cwd when it lives under it, so
  // an inserted file mention stays short + resolves to a clickable chip; else keep it
  // absolute (still readable by Claude and by the mention resolver).
  const relForCwd = (abs: string): string => {
    const base = cwd ? cwd.replace(/\/+$/, "") : "";
    return base && abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
  };

  // Append file-path mentions to the draft (space-separated), caret at the end.
  const insertMentions = (paths: string[]) => {
    if (!paths.length) return;
    const joined = paths.map(relForCwd).join(" ");
    const next = text.trim() ? `${text.replace(/\s*$/, "")} ${joined} ` : `${joined} `;
    setText(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autoGrow();
    });
  };

  // Route picked paths: model-attachable images → base64 attachment; anything else →
  // a path mention Claude reads with its own tools.
  const addPaths = async (paths: string[]) => {
    const mentions: string[] = [];
    const errs: string[] = [];
    // Same send-lock as onPaste: these picked-image reads are async (disk + base64 over
    // IPC, up to 16 MiB), so block send while they're in flight — else a fast
    // pick-then-Enter sends BEFORE the image lands (it would ride the NEXT message).
    setAttaching((n) => n + 1);
    try {
      for (const p of paths) {
        if (wireImageMimeForPath(p)) {
          const res = await attachmentFromPath(p);
          if (res && "error" in res) errs.push(res.error);
          else if (res) useComposerAttachments.getState().add(session, res);
        } else {
          mentions.push(p);
        }
      }
    } finally {
      setAttaching((n) => Math.max(0, n - 1));
    }
    // Surface every failure at once — a later failure must not silently erase earlier ones.
    if (errs.length) setAttachErr([...new Set(errs)].join(" · "));
    insertMentions(mentions);
  };

  // The "+" button: native multi-file picker (any file / image). In the dev/browser
  // mock there's no native dialog, so fall back to a path prompt (mention only).
  const pickAndAttach = async () => {
    setAttachErr(null);
    let paths: string[] = [];
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: true, title: "Attach files or images" });
      paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    } else {
      const p = window.prompt("Path of the file to attach:", "");
      paths = p && p.trim() ? [p.trim()] : [];
    }
    await addPaths(paths);
  };

  // Paste an image (screenshot / copied file) → attachment. Only preventDefault when
  // we actually consumed image data, so plain text paste is untouched.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const blobs: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) blobs.push(f);
      }
    }
    if (!blobs.length) return;
    e.preventDefault();
    setAttachErr(null);
    setAttaching((n) => n + 1);
    void (async () => {
      try {
        for (const b of blobs) {
          const name = b.name && b.name.trim() ? b.name : "Pasted image";
          const res = await attachmentFromBlob(b, name);
          if (res && "error" in res) setAttachErr(res.error);
          else if (res) useComposerAttachments.getState().add(session, res);
          else setAttachErr("Unsupported image format (png, jpeg, gif, webp).");
        }
      } finally {
        setAttaching((n) => Math.max(0, n - 1));
      }
    })();
  };

  // A restored/re-seeded draft can be multi-line; the textarea defaults to one row, so size
  // it to the content on mount, on conversation switch, AND whenever the draft text changes
  // out-of-band (a rewind re-seeds this same conversation's composer via the store, with no
  // DOM change event to trigger autoGrow) rather than leaving it clipped/scrolled. Typing
  // already calls autoGrow in onChange, so the extra run per keystroke is a harmless re-measure.
  useEffect(() => {
    autoGrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, text]);

  // Core send: the typed text plus any joined images. Empty-empty is a no-op (the
  // send button is gated on it too), but text-empty-with-images IS a valid send.
  const sendMessageNow = (t: string, images: UserTurnImage[]) => {
    if (!t && images.length === 0) return;
    // NO busy gate: sending while the agent is working is supported and desirable.
    // The `claude` CLI natively queues a user message received mid-turn and injects
    // it at the next loop boundary (after a tool_result batch, before the next model
    // call), wrapped in "The user sent a new message while you were working: … /
    // IMPORTANT: After completing your current task, you MUST address the user's
    // message above." Holding it app-side until the turn ends would defeat that
    // mid-turn injection — the agent must see it in-flight, not only at the end.
    // Sending also (re)starts the stream lazily if the session is off/ended.
    // A `/goal` command (set / clear / status) is plumbing for the goal chip, not conversational
    // content: send it SILENTLY (no optimistic bubble / title / summary), matching the reloaded
    // thread which drops it as noise. `markGoalSeen` arms the turn-edge refetch so a freshly set
    // goal appears without every goalless conversation paying a per-turn transcript read.
    const goalCmd = isGoalCommand(t);
    if (goalCmd) markGoalSeen(session);
    // Same invariant for the optimistic PLACEHOLDER name — hence computed BEFORE this call: a
    // fresh conversation whose first message is `/goal <condition>` must not end up named after
    // that command in the sidebar and on its Flight Deck card. Goal plumbing is invisible
    // everywhere else, so it must not name the conversation either; the conversation stays
    // auto-title-eligible and gets named by the first REAL message instead.
    if (!goalCmd) useConversationsStore.getState().noteFirstMessage(session, t);
    // The worktree toggle only applies to the very first spawn of a conversation.
    // `queued`: busy at send time → the CLI will inject this mid-turn, so the
    // bubble shows a "pending" badge until the turn ends.
    send.mutate({ text: t, images, worktree: useWorktree && isFresh, queued: busy, silent: goalCmd });
    // `/reload-skills` makes the CLI re-scan on-disk skills; mirror that in the
    // `/` menu by re-fetching this cwd's catalogue (a fresh spawn reads disk
    // afresh), overwriting the once-per-session cache. Fire-and-forget.
    if (isReloadSkillsCommand(t)) void refetchSlashCommands(cwd);
    setText("");
    // Joined images were consumed by this send — drop them so they don't ride the
    // next message.
    useComposerAttachments.getState().clear(session);
    setAttachErr(null);
    histNav.current = IDLE_NAV;
    setSlashToken(null);
    requestAnimationFrame(autoGrow);
    // Sending always snaps the thread to the bottom, even if the user had scrolled
    // up — this re-engages stick-to-bottom so the incoming reply stays in view.
    onSent?.();
  };

  // Text-only send (slash-command run, `/compact`) — never carries attachments.
  const sendText = (raw: string) => sendMessageNow(raw.trim(), []);

  // The composer's primary send (button / Enter): text + this conversation's
  // joined images, stripped of their local ids for the wire + optimistic bubble.
  const doSend = () => {
    // A pasted image is still being read — don't send yet, or it would go out on the
    // NEXT message instead (the async add lands after this send's clear).
    if (attaching > 0) return;
    sendMessageNow(
      text.trim(),
      attachmentsFor(session).map((a) => ({
        mediaType: a.mediaType,
        dataBase64: a.dataBase64,
        name: a.name,
      })),
    );
  };

  /**
   * Accept a slash command from the menu. Mirrors the VS Code extension:
   *  - a bare `/cmd` at the start of the input, taken with Enter/click → RUN it
   *    now (send `/cmd`);
   *  - taken with Tab, or with text before the `/` → INSERT `/cmd ` so arguments
   *    can be typed, caret placed right after.
   */
  const pickCommand = (cmd: SlashCommand, viaTab: boolean) => {
    if (!slashToken) return;
    const before = text.slice(0, slashToken.start);
    const after = text.slice(slashToken.end);
    const hasTextBefore = before.trim().length > 0;

    if (!viaTab && !hasTextBefore) {
      const rest = after.trim();
      sendText(rest ? `/${cmd.name} ${rest}` : `/${cmd.name}`);
      return;
    }

    const insert = `/${cmd.name} `;
    const next = before + insert + (after.startsWith(" ") ? after.slice(1) : after);
    const caret = before.length + insert.length;
    setText(next);
    setSlashToken(null);
    setSlashDismissed(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      autoGrow();
    });
  };

  /** Fill the composer with a recalled message and park the caret at its end. */
  const applyRecall = (res: RecallResult) => {
    histNav.current = res.nav;
    setText(res.text);
    setSlashToken(null);
    setSlashDismissed(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autoGrow();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the `/` menu is open it owns the navigation/commit keys.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pickCommand(slashMatches[activeIdx], e.key === "Tab");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    // ⇧Tab cycles the safety selector: Claude's permission mode, or Codex's
    // sandbox/approval PRESET — the same muscle-memory across both backends.
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (backend === "claude") cyclePermMode();
      else cyclePreset();
      return;
    }
    // ↑/↓ recall previously-sent messages, shell-style — but only at the field's
    // edge (caret on the first line for ↑, last line for ↓) so multi-line editing
    // and the modifier combos (⌥/⌘/⇧ + arrow = caret/selection) keep working.
    const bareArrow = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (e.key === "ArrowUp" && bareArrow) {
      const ta = e.currentTarget;
      if (caretOnFirstLine(ta.value, ta.selectionStart ?? 0)) {
        const res = recallPrev(history, histNav.current, text);
        if (res) {
          e.preventDefault();
          applyRecall(res);
          return;
        }
      }
    }
    if (e.key === "ArrowDown" && bareArrow) {
      const ta = e.currentTarget;
      if (
        histNav.current.index !== null &&
        caretOnLastLine(ta.value, ta.selectionEnd ?? ta.value.length)
      ) {
        const res = recallNext(history, histNav.current);
        if (res) {
          e.preventDefault();
          applyRecall(res);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="cv-composer">
      {slashOpen ? (
        <SlashCommandMenu
          items={slashMatches}
          activeIndex={activeIdx}
          onHover={setSlashActive}
          onPick={(cmd) => pickCommand(cmd, false)}
        />
      ) : null}
      {attachments.length > 0 || attachErr ? (
        <div className="cv-attach-row">
          {attachments.map((a) => (
            <div key={a.id} className="cv-attach" title={a.name}>
              <img className="cv-attach-thumb" src={imageDataUrl(a)} alt={a.name ?? "image"} />
              <span className="cv-attach-name">{a.name ?? "image"}</span>
              <button
                type="button"
                className="cv-attach-x"
                title="Remove"
                aria-label="Remove attachment"
                onClick={() => useComposerAttachments.getState().remove(session, a.id)}
              >
                <Ico name="x" className="sm" />
              </button>
            </div>
          ))}
          {attachErr ? <span className="cv-attach-err">{attachErr}</span> : null}
        </div>
      ) : null}
      <div className="cv-input">
        <button
          type="button"
          className="cv-add"
          onClick={() => void pickAndAttach()}
          title="Attach a file or image"
          aria-label="Attach a file or image"
        >
          <Ico name="plus" className="sm" />
        </button>
        <textarea
          ref={taRef}
          className={styles.ta}
          rows={1}
          value={text}
          placeholder={
            busy
              ? "The agent is working — your message will be picked up along the way…"
              : "Ask the agent, @ for a file, / for a command…"
          }
          onChange={(e) => {
            // Genuine typing exits history navigation: the edited text becomes the
            // new live draft (a later ↑ re-stashes it and starts from the newest).
            histNav.current = IDLE_NAV;
            setText(e.target.value);
            setSlashDismissed(false);
            syncSlashToken(e.currentTarget);
            autoGrow();
          }}
          onSelect={(e) => syncSlashToken(e.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
        />
        {/* While busy with an empty box (no text AND no attachments), the action is
            "interrupt". As soon as there is something to send — text or a joined image,
            busy or not — it's a send button: a message sent mid-turn is natively queued
            by the CLI and injected at the next loop boundary. */}
        {busy && !text.trim() && attachments.length === 0 && attaching === 0 ? (
          <button className="cv-send" onClick={() => interrupt.mutate()} title="Interrupt">
            <Ico name="stop" className="sm" />
          </button>
        ) : (
          <button
            className="cv-send"
            onClick={doSend}
            disabled={(!text.trim() && attachments.length === 0) || attaching > 0}
            title={busy ? "Send — the agent will handle it along the way" : "Send"}
          >
            <Ico name="send" className="sm" />
          </button>
        )}
      </div>

      <div className="cv-comp-foot">
        {/* Model picker — UNIFIED across backends: choosing a model IS how the backend
            is chosen (a Codex model ⇒ a Codex conversation). Sections per backend
            (Claude / Codex), the chip wears the matching brand mark. While fresh, both
            backends are offered so the pick sets the backend; once a message is sent the
            backend is frozen and the picker locks to it (see modelsForPicker). */}
        <Menu
          up
          trigger={
            <ChipBtn iconNode={backend === "codex" ? <CodexMark /> : <ClaudeMark />}>
              {modelLabel(modelId)}
            </ChipBtn>
          }
        >
          {pickerGroups.map((g) => (
            <Fragment key={g.backend}>
              <MenuLabel>
                <span className="wf-mi-lbl-brand">
                  {g.backend === "codex" ? <CodexMark /> : <ClaudeMark />}
                  {g.label}
                  {/* Definitive logged-out flag only (a failed probe shows nothing) —
                      picking a model of a disconnected backend WILL fail on send. */}
                  {(g.backend === "codex" ? loggedOut.codex : loggedOut.claude) ? (
                    <span className="wf-mi-lbl-warn">not connected</span>
                  ) : null}
                </span>
              </MenuLabel>
              {g.models.map((m) => (
                <MenuItem
                  key={m.value}
                  on={modelFamily(modelId) === m.value}
                  onClick={() => chooseModel(m.value, m.backend)}
                >
                  {m.label}
                </MenuItem>
              ))}
            </Fragment>
          ))}
          {/* Once locked, the other backend is gone from the list — say why, so a user
              who saw both sections before the first message understands. */}
          {locked && codexAvailable ? (
            <MenuItem disabled>Backend locked after the first message</MenuItem>
          ) : null}
        </Menu>
        {/* Effort gauge — BOTH backends (levels are backend-aware: Claude adds max/Ultra
            code, Codex is low→xhigh, gpt-5.6 adds max+ultra; renders nothing when the model
            has no effort, e.g. Haiku). Claude pushes it live; Codex applies it as the next
            turn's override. */}
        <EffortGauge
          model={modelId}
          value={gaugeValue}
          onChange={chooseEffort}
          efforts={
            backend === "codex"
              ? // Data-driven from the selected model; fall back to the per-model static
                // ladder (gpt-5.6 → max+ultra, older gpt-5.x → low→xhigh) so a Codex conv
                // shows the right rungs even if its persisted model id isn't in the dynamic
                // list — and never Claude-only tiers.
                (codexEfforts[modelId] ?? effortLevelsForModel(modelId))
              : undefined
          }
        />
        <span className="cv-foot-sep" />
        {backend === "claude" ? (
          /* Claude permission mode (set_permission_mode). ⇧Tab cycles modes. Colour-coded. */
          <Menu
            up
            trigger={
              <ChipBtn icon="shield" data-perm={permMode} title="Permission mode — ⇧Tab to change">
                {permLabel}
              </ChipBtn>
            }
          >
            <MenuLabel>Permission mode · ⇧Tab</MenuLabel>
            {PERM_OPTS.map(([label, value, disabled]) => (
              <MenuItem
                key={value}
                on={permMode === value}
                disabled={disabled}
                onClick={disabled ? undefined : () => choosePerm(value)}
              >
                <span className="cv-perm-dot" style={{ background: PERM_TONE[value] }} />
                {label}
              </MenuItem>
            ))}
          </Menu>
        ) : (
          /* Codex controls — all applied as per-turn overrides (see codexControls). */
          <>
            {/* Safety PRESET = sandbox × approval, like OpenAI's VS Code dropdown. The
                chip is colour-coded per preset (like Claude's permission mode), ⇧Tab
                cycles (same muscle-memory). */}
            <Menu
              up
              trigger={
                <ChipBtn
                  icon="shield"
                  data-codex-preset={codexCtl.preset}
                  title="Codex safety (sandbox × approval) — ⇧Tab to change"
                >
                  {CODEX_PRESETS[codexCtl.preset].label}
                </ChipBtn>
              }
            >
              <MenuLabel>Codex safety · ⇧Tab</MenuLabel>
              {PRESET_ORDER.map((p) => (
                <MenuItem
                  key={p}
                  on={codexCtl.preset === p}
                  hint={CODEX_PRESETS[p].hint}
                  onClick={() => useCodexControls.getState().set(session, { preset: p })}
                >
                  <span className="cv-perm-dot" style={{ background: CODEX_PRESETS[p].tone }} />
                  {CODEX_PRESETS[p].label}
                </MenuItem>
              ))}
            </Menu>
            {/* Service tier ("Fast") — a per-turn speed/priority override, shown ONLY when the
                selected model advertises a real choice (≥2 tiers). Parity with the Codex-native
                Fast tier; the chip lights up when a non-default (faster) tier is active. */}
            {(() => {
              const tiers = codexTiers[modelId] ?? [];
              if (tiers.length < 2) return null;
              const defaultTier = codexDefaultTier[modelId] ?? null;
              const currentId = codexCtl.serviceTier ?? defaultTier;
              const current = tiers.find((t) => t.id === currentId) ?? null;
              const boosted = currentId != null && currentId !== defaultTier;
              return (
                <Menu
                  up
                  trigger={
                    <ChipBtn
                      icon="bolt"
                      data-codex-fast={boosted ? "on" : undefined}
                      title="Codex speed (service tier) — per-turn override"
                    >
                      {current?.name || "Speed"}
                    </ChipBtn>
                  }
                >
                  <MenuLabel>Codex speed</MenuLabel>
                  {tiers.map((t) => (
                    <MenuItem
                      key={t.id}
                      on={currentId === t.id}
                      hint={t.description || undefined}
                      onClick={() =>
                        useCodexControls.getState().set(session, {
                          // Default tier → clear (follow the model default); else store the id.
                          serviceTier: t.id === defaultTier ? undefined : t.id,
                        })
                      }
                    >
                      {t.name || t.id}
                    </MenuItem>
                  ))}
                </Menu>
              );
            })()}
            {/* The remaining Codex-only settings folded into ONE menu to keep the composer
                tidy: network access (sandbox), reasoning-summary verbosity, personality. */}
            <Menu
              up
              trigger={
                <ChipBtn
                  icon="cog"
                  title="Codex options — network access, reasoning summary, personality"
                  aria-label="Codex options"
                />
              }
            >
              <MenuLabel>Sandbox network</MenuLabel>
              <MenuItem
                on={codexCtl.network}
                icon="globe"
                onClick={() =>
                  useCodexControls.getState().set(session, { network: !codexCtl.network })
                }
              >
                Network access
              </MenuItem>
              <MenuLabel>Reasoning summary</MenuLabel>
              {CODEX_SUMMARY_OPTS.map(([label, value]) => (
                <MenuItem
                  key={value}
                  on={codexCtl.summary === value}
                  onClick={() => useCodexControls.getState().set(session, { summary: value })}
                >
                  {label}
                </MenuItem>
              ))}
              <MenuLabel>Personality</MenuLabel>
              {CODEX_PERSONALITY_OPTS.map(([label, value]) => (
                <MenuItem
                  key={value}
                  on={codexCtl.personality === value}
                  onClick={() => useCodexControls.getState().set(session, { personality: value })}
                >
                  {label}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
        <span style={{ marginLeft: "auto" }} />
        {/* Artifacts index — every artifact Claude published in THIS conversation, with its
            versions. Renders only when there is ≥1 (Codex conversations never yield any).
            Read-only toward claude.ai (surfaces the transcript; never republishes). */}
        <ArtifactsChip session={session} />
        {/* Extensions panel — what this conversation's Claude sees (MCP + live
            status, plugins, skills, sub-agents), like /mcp. Scans the session's
            current cwd so a worktree shows its own config. */}
        <button
          type="button"
          className="wf-chip"
          onClick={() =>
            openExtensions({
              kind: "conversation",
              backend,
              path: state?.cwd ?? cwd ?? ".",
              title: convName,
              session,
            })
          }
          title="This conversation's extensions — MCP (live status), plugins, skills, sub-agents"
          aria-label="Extensions"
        >
          <Ico name="layers" className="sm" />
        </button>
        {/* Clean-output toggle — fold each round's work behind a "Claude's work"
            block so only the final message stays in clear. PER-CONVERSATION: the toggle
            writes THIS conversation's explicit override (the global default lives in
            Settings → General). On-state borrows the accent like the worktree checkbox. */}
        <button
          type="button"
          role="switch"
          aria-checked={cleanOutput}
          className="wf-chip"
          onClick={() =>
            useConversationsStore.getState().setConvCleanOutput(session, !cleanOutput)
          }
          title="Clean output (this conversation) — show only the final message of each response; fold the intermediate work (tools, thinking, steps)"
          aria-label="Clean output"
          style={
            cleanOutput
              ? { borderColor: "var(--wf-accent)", color: "var(--wf-accent)" }
              : undefined
          }
        >
          <Ico name="list" className="sm" />
        </button>
        {/* Remote control — bridge this conversation to a phone/web. Backend-aware:
            Claude rides its control channel (→ a claude.ai/code URL); Codex uses its native
            `remoteControl/enable` (→ a device-pairing code). The chip adapts its active menu
            to the backend. */}
        <RemoteControlChip session={session} backend={backend} worktreeOnSpawn={useWorktree && isFresh} />
        {/* Active `/goal` — a target button; click opens a popover with the condition + a clear
            button. Renders nothing when no goal is active. Claude only (Codex has no `/goal`). */}
        {!isCodex ? <GoalChip convId={session} /> : null}
        {/* Worktree checkbox — only before the session spawns (first message).
            Explicit empty/checked box so the on/off state is unambiguous. */}
        {isFresh ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={useWorktree}
            className="cv-wt-toggle"
            onClick={() => setUseWorktree((v) => !v)}
            title="Start this conversation in a new git worktree"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              font: "inherit",
              fontSize: 11,
              cursor: "pointer",
              padding: "4px 9px",
              borderRadius: 7,
              border: `1px solid ${useWorktree ? "var(--wf-accent)" : "var(--wf-line)"}`,
              background: "transparent",
              color: useWorktree ? "var(--wf-accent)" : "var(--wf-tx-lo)",
            }}
          >
            <span
              style={{
                width: 13,
                height: 13,
                flex: "0 0 auto",
                borderRadius: 3,
                border: `1.5px solid ${useWorktree ? "var(--wf-accent)" : "var(--wf-line-2)"}`,
                background: useWorktree ? "var(--wf-accent)" : "transparent",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#1a0f0a",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              {useWorktree ? "✓" : ""}
            </span>
            <Ico name="branch" className="sm" />
            <span className="cv-wt-label">Worktree</span>
          </button>
        ) : null}
        <ContextRing
          ctx={ctxData}
          plan={isCodex ? null : planData}
          disabled={!ctxReady}
          onCompact={usage.onCompact}
          usage={usage.usage}
          usageLoading={usage.usageLoading}
          usageError={usage.usageError}
          usageUpdatedAt={usage.usageUpdatedAt}
          usageBackend={usage.usageBackend}
          onOpenUsage={usage.onOpenUsage}
          onRefreshUsage={usage.onRefreshUsage}
        />
      </div>
    </div>
  );
});
