// The proposed-plan card (ExitPlanMode). Renders the agent's plan markdown prominently and,
// while the plan awaits approval, hosts the decision directly on the card: accept it, or
// reject-and-revise with feedback. The user can select any passage of the plan to attach a
// comment; those comments are highlighted inline (CSS Custom Highlight API) and, on "reject &
// revise", bundled into the deny message the agent reads (see buildRejectionMessage) so it
// reworks the plan. Once resolved, the card shows a persistent Accepted/Rejected badge derived
// from the tool_result (so a reloaded/historical plan reads correctly).
//
// It replaces the generic tool card AND the generic permission prompt for ExitPlanMode: the
// tool is pulled out as its own `plan` segment (see toolGroup) and the matching permission is
// suppressed from the bottom AskTurn list (see ConductorThread) — this card owns both.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { useAnswerPermission } from "../../ipc/useCommands";
import { usePendingPermission, useToolResult } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import {
  newAnnotationId,
  usePlanAnnotations,
  usePlanAnnotationsStore,
  usePlanNote,
  type PlanAnnotation,
} from "../../store/planAnnotations";
import { Ico } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { buildRejectionMessage, planResultDecision } from "./planStatus";
import { chordLabel } from "../../ui/platform";

// ---- CSS Custom Highlight API registry ------------------------------------------------
// All plan cards share ONE named highlight; each card contributes its ranges through a
// provider so several cards never clobber each other under the same name. Ranges are rebuilt
// from stored character offsets on every publish (the plan markdown is immutable, so offsets
// stay valid), which also sidesteps stale-DOM ranges across re-renders. Degrades to no visual
// highlight (annotations still listed) where the API is unavailable.
// Two layers: SAVED comments (solid) and the IN-PROGRESS draft being commented (dashed), so
// the passage you're annotating right now reads differently from ones already commented.
const HL_SAVED = "tosse-plan-annotation";
const HL_DRAFT = "tosse-plan-draft";
interface RangeSet {
  saved: Range[];
  draft: Range[];
}
type RangeProvider = () => RangeSet;
const providers = new Map<string, RangeProvider>();

interface HighlightCtor {
  new (...ranges: Range[]): unknown;
}
interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { Ctor: HighlightCtor; reg: HighlightRegistry } | null {
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  if (!Ctor || !reg) return null;
  return { Ctor, reg };
}

function publishLayer(
  api: { Ctor: HighlightCtor; reg: HighlightRegistry },
  name: string,
  ranges: Range[],
): void {
  if (ranges.length === 0) api.reg.delete(name);
  else api.reg.set(name, new api.Ctor(...ranges));
}

function republishHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  const saved: Range[] = [];
  const draft: Range[] = [];
  for (const p of providers.values()) {
    try {
      const rs = p();
      saved.push(...rs.saved);
      draft.push(...rs.draft);
    } catch {
      /* a stale range from an unmounting card — skip it */
    }
  }
  publishLayer(api, HL_SAVED, saved);
  publishLayer(api, HL_DRAFT, draft);
}

// ---- DOM offset helpers ---------------------------------------------------------------

/** Character offsets [start, end) of a selection range within `root`'s text, or null if the
 *  selection is empty. Measured against the same text stream that {@link rangeFromOffsets}
 *  walks, so a stored offset round-trips back to the same range. */
function selectionOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const len = range.toString().length;
  if (len === 0) return null;
  return { start, end: start + len };
}

/** Rebuild a DOM Range from character offsets by walking `root`'s text nodes. */
function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  if (start >= end) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (!startNode && acc + len > start) {
      startNode = node;
      startOffset = start - acc;
    }
    if (acc + len >= end) {
      endNode = node;
      endOffset = end - acc;
      break;
    }
    acc += len;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r;
  } catch {
    return null;
  }
}

// ---- Component ------------------------------------------------------------------------

interface Draft {
  start: number;
  end: number;
  quote: string;
}

// The floating composer's approximate size, used to keep it on-screen (clamp/flip). Exact
// pixels don't matter — it just needs to be close enough to decide "does it overflow".
const COMPOSER_W = 300;
const COMPOSER_H = 150;
const VIEWPORT_MARGIN = 8;

type Decision = "pending" | "approved" | "rejected" | "none";

export function PlanCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const plan = field(input, "plan") ?? "";
  const pending = usePendingPermission(session, toolUseId);
  const result = useToolResult(session, toolUseId);
  const annotations = usePlanAnnotations(session, toolUseId);
  const answer = useAnswerPermission(session);
  const addAnn = usePlanAnnotationsStore((s) => s.add);
  const removeAnn = usePlanAnnotationsStore((s) => s.remove);

  const decision: Decision = pending
    ? "pending"
    : result
      ? mapResult(planResultDecision(result.content, result.isError))
      : "none";
  const interactive = decision === "pending";

  const note = usePlanNote(session, toolUseId);
  const setNote = usePlanAnnotationsStore((s) => s.setNote);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The composer textarea is CONTROLLED (reset per selection) so a re-selection can never carry
  // the previous passage's typed text onto the new passage's quote.
  const [draftText, setDraftText] = useState("");
  // The composer's viewport anchor, recomputed from the live selection range (so it follows the
  // passage on scroll/resize) and clamped/flipped to stay on-screen.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Keep the highlight provider reading the latest annotations + draft via refs, so we register
  // once per card and just republish when they change.
  const annRef = useRef(annotations);
  annRef.current = annotations;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useLayoutEffect(() => {
    const key = `${session}:${toolUseId}`;
    providers.set(key, () => {
      const root = bodyRef.current;
      if (!root) return { saved: [], draft: [] };
      const saved: Range[] = [];
      for (const a of annRef.current) {
        const r = rangeFromOffsets(root, a.start, a.end);
        if (r) saved.push(r);
      }
      const draftRanges: Range[] = [];
      const d = draftRef.current;
      if (d) {
        const r = rangeFromOffsets(root, d.start, d.end);
        if (r) draftRanges.push(r);
      }
      return { saved, draft: draftRanges };
    });
    republishHighlights();
    // The plan body re-renders asynchronously (highlight.js swaps a fenced block's text node
    // for token spans AFTER a lazy import; the plan itself streams in). Those mutations detach
    // our published ranges without touching any React dep, so observe the subtree and rebuild.
    const root = bodyRef.current;
    let raf = 0;
    const obs =
      root && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
              raf = 0;
              republishHighlights();
            });
          })
        : null;
    if (obs && root) obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      providers.delete(key);
      if (raf) cancelAnimationFrame(raf);
      obs?.disconnect();
      republishHighlights();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, toolUseId]);

  // Rebuild the visual highlights whenever the annotations, the in-progress draft, or the plan
  // text change (the last covers the streamed-in plan settling to its final form).
  useLayoutEffect(() => {
    republishHighlights();
  }, [annotations, draft, plan]);

  // Clear the native selection ONLY when it lives inside THIS card's plan body. The Selection
  // API is document-global, so an unscoped removeAllRanges would wipe a selection the user made
  // elsewhere on screen (e.g. copying from another message) whenever this card tears down a draft
  // — including when the plan is answered from phone/web. Scoping it keeps foreign selections.
  const clearOwnSelection = () => {
    const sel = window.getSelection();
    const root = bodyRef.current;
    if (sel && root && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer))
      sel.removeAllRanges();
  };

  // Dismiss the in-progress draft: drop the composer, reset its text, and clear our own passage's
  // selection so it stops looking highlighted (the draft highlight is keyed off `draft`; the OS
  // selection tint would linger otherwise — the "Cancel left it highlighted" bug).
  const clearDraft = () => {
    setDraft(null);
    setDraftText("");
    clearOwnSelection();
  };

  // A resolved plan can't be annotated: tear down any open draft the moment the card stops being
  // interactive (decided elsewhere, e.g. accept/reject, or answered from phone/web), so no stray
  // composer/highlight floats over the settled card.
  useEffect(() => {
    if (!interactive && draft) clearDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // Anchor the composer to the live selection rect, recomputed on scroll/resize and clamped to
  // the viewport (flip above the selection if it would overflow the bottom).
  useLayoutEffect(() => {
    if (!draft) {
      setPos(null);
      return;
    }
    const place = () => {
      const root = bodyRef.current;
      if (!root) return;
      const r = rangeFromOffsets(root, draft.start, draft.end);
      const rect = r?.getBoundingClientRect();
      if (!rect) return;
      const maxLeft = window.innerWidth - COMPOSER_W - VIEWPORT_MARGIN;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
      let top = rect.bottom + 6;
      if (top + COMPOSER_H > window.innerHeight)
        top = Math.max(VIEWPORT_MARGIN, rect.top - COMPOSER_H - 6);
      setPos({ left, top });
    };
    // rAF-coalesce scroll/resize: a burst of events measures at most once per frame. `place`
    // walks the plan body's text nodes (rangeFromOffsets) then getBoundingClientRect (a forced
    // synchronous layout), so calling it per raw scroll event would thrash layout while a
    // composer is open. The initial placement runs synchronously below.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    place();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [draft]);

  const onMouseUp = () => {
    if (!interactive) return;
    const root = bodyRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // A plain click (no selection) inside the plan dismisses an open composer.
      if (draftRef.current) clearDraft();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const off = selectionOffsets(root, range);
    if (!off) return;
    setDraft({ ...off, quote: range.toString() });
    setDraftText("");
    // Replace the native selection with our own persistent draft highlight: it survives the
    // composer stealing focus, and cancelling then fully clears the passage.
    sel.removeAllRanges();
  };

  const commitDraft = () => {
    const comment = draftText.trim();
    if (!draft || comment === "") return; // a comment must carry text — no empty flags
    const ann: PlanAnnotation = {
      id: newAnnotationId(),
      start: draft.start,
      end: draft.end,
      quote: draft.quote,
      comment,
    };
    addAnn(session, toolUseId, ann);
    setDraft(null);
    setDraftText("");
    clearOwnSelection();
  };

  const accept = () => {
    clearDraft();
    answer.mutate(
      {
        requestId: pending!.request_id,
        decision: { behavior: "allow", updated_input: null },
      },
      {
        // Approving a plan exits plan mode; the CLI would otherwise drop to "default". Switch to
        // "auto" (auto-accept) instead. Done in onSuccess so the mode change is written to the
        // control channel AFTER the approval — FIFO ordering means our "auto" wins over the CLI's
        // implicit reset. setConvPermission both persists the choice and pushes set_permission_mode.
        onSuccess: () =>
          useConversationsStore.getState().setConvPermission(session, "auto"),
      },
    );
  };

  const rejectAndRevise = () => {
    clearDraft();
    answer.mutate({
      requestId: pending!.request_id,
      decision: { behavior: "deny", message: buildRejectionMessage(annotations, note) },
    });
    setNote(session, toolUseId, "");
  };

  // Every saved annotation carries a comment (empty ones can't be committed), so the count is
  // simply how many there are; feedback exists when there's a comment or a general note.
  const commentCount = annotations.length;
  // The user has expressed feedback → sending it (a reject-and-revise) becomes the primary
  // action, and plain "Accepter" steps back. With no feedback, accept is the primary action and
  // the secondary is a plain refuse.
  const hasFeedback = commentCount > 0 || note.trim() !== "";

  return (
    <div className={"cv-plan" + (decision !== "none" ? ` is-${decision}` : "")}>
      <div className="cv-plan-h">
        <Ico name="clipboard" className="sm cv-plan-ico" />
        <span className="cv-plan-t">Proposed plan</span>
        <PlanBadge decision={decision} />
      </div>

      <div
        ref={bodyRef}
        className="cv-plan-body md-body"
        onMouseUp={onMouseUp}
        // Hint the user the text is selectable-to-comment only while it can drive a revision.
        data-annotatable={interactive ? "1" : undefined}
      >
        <StreamMarkdown text={plan} />
      </div>

      {commentCount > 0 && (
        <div className="cv-plan-notes">
          <div className="cv-plan-notes-h">
            <Ico name="chat" className="sm" />
            {commentCount} comment{commentCount > 1 ? "s" : ""}
          </div>
          {annotations.map((a) => (
            <div key={a.id} className="cv-plan-note">
              <span className="cv-plan-note-quote" title={a.quote}>
                {a.quote}
              </span>
              <span className="cv-plan-note-c">
                {a.comment.trim() ? a.comment : <em className="cv-plan-note-empty">no note</em>}
              </span>
              {interactive && (
                <button
                  className="cv-plan-note-del"
                  title="Delete this comment"
                  onClick={() => removeAnn(session, toolUseId, a.id)}
                >
                  <Ico name="trash" className="sm" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {interactive && (
        <div className="cv-plan-foot">
          <textarea
            className="cv-plan-noteinput"
            placeholder="General feedback on the plan (optional)…"
            value={note}
            rows={2}
            onChange={(e) => setNote(session, toolUseId, e.target.value)}
            onKeyDown={(e) => {
              // Keep typing keys local; only let thread-level shortcuts (⌘…) bubble.
              if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            }}
          />
          <div className="cv-plan-actions">
            {hasFeedback ? (
              <>
                <button className="wf-btn ghost sm" onClick={accept}>
                  <Ico name="check" className="sm" />
                  Accept anyway
                </button>
                <button className="wf-btn prim sm" onClick={rejectAndRevise}>
                  <Ico name="reply" className="sm" />
                  Send feedback
                  {commentCount > 0 ? ` (${commentCount})` : ""}
                </button>
              </>
            ) : (
              <>
                <button className="wf-btn ghost sm" onClick={rejectAndRevise}>
                  <Ico name="x" className="sm" />
                  Reject
                </button>
                <button className="wf-btn prim sm" onClick={accept}>
                  <Ico name="check" className="sm" />
                  Accept the plan
                </button>
              </>
            )}
          </div>
          <div className="cv-plan-hint">
            {hasFeedback
              ? '"Send feedback" sends your comments back to the agent so it revises the plan.'
              : "Select a passage of the plan to comment on it, then send your feedback to the agent."}
          </div>
        </div>
      )}

      {interactive && draft && pos && (
        <div
          // Keyed on the passage so a re-selection remounts a fresh, empty, re-focused composer.
          key={`${draft.start}-${draft.end}`}
          className="cv-plan-composer"
          style={{ left: pos.left, top: pos.top }}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <textarea
            autoFocus
            className="cv-plan-composer-input"
            placeholder="Your comment…"
            rows={2}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // stopPropagation so this Escape only cancels the comment draft — it
                // must not also bubble to a window-level closer (e.g. the Flight Deck
                // reply modal), per the "one key = one layer" convention.
                e.preventDefault();
                e.stopPropagation();
                clearDraft();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitDraft();
              } else if (!e.metaKey && !e.ctrlKey) {
                e.stopPropagation();
              }
            }}
          />
          <div className="cv-plan-composer-foot">
            <span className="cv-plan-composer-hint">{chordLabel("⌘⏎ to add")}</span>
            <span className="cv-plan-composer-btns">
              <button className="wf-btn ghost sm" onClick={clearDraft}>
                Cancel
              </button>
              <button
                className="wf-btn prim sm"
                disabled={draftText.trim() === ""}
                onClick={commitDraft}
              >
                Add
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function mapResult(d: "approved" | "rejected" | "unknown"): Decision {
  return d === "unknown" ? "none" : d;
}

function PlanBadge({ decision }: { decision: Decision }) {
  if (decision === "approved")
    return (
      <span className="cv-plan-badge is-approved">
        <Ico name="check" className="sm" />
        Accepted
      </span>
    );
  if (decision === "rejected")
    return (
      <span className="cv-plan-badge is-rejected">
        <Ico name="x" className="sm" />
        Rejected
      </span>
    );
  if (decision === "pending")
    return (
      <span className="cv-plan-badge is-pending">
        <Ico name="clock" className="sm" />
        Pending
      </span>
    );
  return null;
}
