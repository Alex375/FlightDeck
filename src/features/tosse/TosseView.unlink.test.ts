// Hover-revealed row tools, and the keyboard.
//
// Two boxes in this view are `display: none` until the row they sit on is hovered — the ×
// that unlinks a conversation from a task (detail panel) and the Start/Discuss/close
// buttons on a task row (board). `display: none` is deliberate in both: a flex icon button
// never collapses to zero width, so the row's title only gets its room back when the box
// leaves the layout entirely. What it also does is take the box OUT OF THE TAB ORDER — and
// a reveal rule hung off the box's own `:focus-within`/`:focus-visible` can never match,
// because nothing inside it can be focused while it is hidden and it stays hidden until
// something inside it is focused. The reveal has to hang off an ANCESTOR that is focusable
// (or holds a focusable child) while the box is still hidden: the row.
//
// Three halves, because none covers it alone:
//  - the stylesheet is read as TEXT. jsdom has no layout and never re-evaluates `:focus-*`
//    in `getComputedStyle` (measured: focusing the row leaves the computed `display` at
//    `none`), so the cascade these bugs live in cannot be asserted through the DOM. Every
//    test below that only reads `css` says so in its name;
//  - the DOM PREMISE the cascade stands on — that the row really is focusable and really
//    does contain the box — is asserted for real, through react-dom/client;
//  - so is the journey: reach the ×, activate it, land in the confirmation, come back out,
//    and (the part that has nothing to do with CSS) find the keyboard somewhere useful.
//
// ⚠️ House rule on tests: a test that passes identically with and without the fix proves
// nothing. Each one below is either a proof — its name says what breaks without it — or is
// named `guardrail:` and is explicitly only a non-regression fence.
//
// `*.test.ts` (the vitest glob), so elements are built with createElement — no JSX.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TosseBriefing, TosseTask } from "../../ipc/client";
import type { Conversation } from "../../store/conversationsStore";

// Read from disk, not imported: a `.module.css` import hands back the class-name map (and
// `?raw` on one is intercepted the same way), so the only way to look at the rules is the
// file itself. Built with `path`, not `new URL(…, import.meta.url)` — Vite rewrites THAT
// pattern into an asset URL (`http://localhost:3000/…`) before the test ever runs.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "TosseView.module.css"),
  "utf8",
);

// The panel's own data. The conversations section is fed by the local store, not by the
// CRM, so `data: undefined` — the honest shape while a detail is loading — renders it
// either way. `briefing` is set per test, for the board-level render.
const state = { briefing: undefined as TosseBriefing | undefined };
const mutation = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });

vi.mock("../../ipc/useTosse", () => ({
  useTosseBriefing: () => ({
    data: state.briefing,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    dataUpdatedAt: 0,
  }),
  useTosseTaskDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useTosseOffBoard: () => ({ data: [], isLoading: false, error: null }),
  useSetTosseTaskStatus: () => mutation(),
  useSetTosseProjectStatus: () => mutation(),
  useCreateTosseTask: () => mutation(),
  useTosseWebUrl: () => ({ data: "https://tosse.example", error: null }),
  useTosseProjectRepos: () => ({ data: [] }),
  useTosseRepoLinks: () => ({ data: undefined }),
  useLinkTosseProjectRepo: () => mutation(),
}));

// The opener plugin has no Tauri host under vitest.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TaskDetail, TosseView } from "./TosseView";
import { useConversationsStore } from "../../store/conversationsStore";
import { useTosseFold } from "../../store/tosseFold";

const TASK = "t-42";

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    name: "Keyboard unlink",
    repoId: "r1",
    cwd: "/tmp/r1",
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: null,
    handle: null,
    liveCwd: null,
    bypassAllowed: false,
    model: "opus",
    effort: "xhigh",
    ultracode: false,
    permissionMode: "default",
    pendingReminder: null,
    tosseTaskId: TASK,
    tosseTaskTitle: "Fix the thing",
    tosseTaskStatus: "En cours",
    claudeAccountId: null,
    cleanOutput: null,
    kind: "claude",
    ...over,
  };
}

// ---- the stylesheet ------------------------------------------------------

/** Every rule in the module, innermost first — the regex can't match across a `{`, so an
 *  at-rule's prelude is skipped and its inner rules are read like any other. */
function rules(): { selectors: string[]; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ""); // a selector inside a comment isn't one
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((x) => x.trim()).filter(Boolean),
    body: m[2],
  }));
}

/** The rules whose selector list contains exactly `selector`. */
function rulesFor(selector: string) {
  return rules().filter((r) => r.selectors.includes(selector));
}

/** Every selector that puts something back into the layout — the reveal conditions. */
function revealSelectors(): string[] {
  return rules()
    .filter((r) => /display:\s*(inline-flex|flex|inline-block|block|grid)\b/.test(r.body))
    .flatMap((r) => r.selectors);
}

describe("stylesheet: the × that unlinks a conversation", () => {
  it("guardrail: still leaves the layout at rest, so the row's title keeps the room", () => {
    // Non-regression fence only. This is the PREMISE of the bug, not the fix: it held
    // before and after, and if it ever stops holding the rules below become pointless.
    const rest = rulesFor(".convUnlink");
    expect(rest.some((r) => /display:\s*none/.test(r.body))).toBe(true);
  });

  // Without this the reveal hangs off the button's own focus and the keyboard never brings
  // the × back into the layout — Tab goes straight past the only way to unlink.
  it("is revealed by the keyboard reaching the ROW", () => {
    expect(revealSelectors()).toContain(".convItem:focus-within .convUnlink");
  });

  // The dead selector. `.convUnlink` is a DESCENDANT of `.convItem`, so `:focus-within` on
  // the item already covers exactly the state where the × itself holds the focus — and a
  // rule keyed on the hidden button's own focus could not match in any other state either.
  // Kept, it reads as a second condition that does something. It does not.
  it("is NOT also hung off the hidden button's own :focus-visible", () => {
    expect(revealSelectors()).not.toContain(".convUnlink:focus-visible");
  });

  // On a near-black panel a dimmed glyph doesn't read as the thing about to be activated,
  // and a brightness/opacity nudge is invisible there — the focused state has to change the
  // base colours and draw the app's ring. (Two rules, not one: this one only STYLES the
  // focus, the reveal above decides whether the × is in the layout at all.)
  it("draws the app's focus ring — 2px of accent, 1px clear of the box", () => {
    const body = rulesFor(".convUnlink:focus-visible").map((r) => r.body).join("");
    expect(body).toMatch(/background:/);
    expect(body).not.toMatch(/filter:\s*brightness/);
    // The convention, verbatim from conductor-flightdeck.css:107 and
    // conductor-conversation.css:524 — a 1px inset ring was this view's own invention.
    expect(body).toMatch(/outline:\s*2px solid var\(--wf-accent\)/);
    expect(body).toMatch(/outline-offset:\s*1px/);
  });
});

describe("stylesheet: the Start / Discuss buttons on a task row", () => {
  it("guardrail: still leave the layout at rest, so the title keeps the room", () => {
    // Same fence as above, one row higher: the premise, not the fix.
    expect(rulesFor(".rowActs").some((r) => /display:\s*none/.test(r.body))).toBe(true);
  });

  // The same dead selector, on the same stylesheet: `.rowActs:focus-within` cannot match
  // while `.rowActs` is `display: none`, so these buttons were simply unreachable without a
  // pointer. Asserted over the WHOLE file because the selector appeared twice — once as the
  // reveal, once inside `.row:has(…)` deciding whether the linked-conversation mark steps
  // aside for them.
  it("are NOT revealed by a condition inside the hidden box", () => {
    expect(rules().flatMap((r) => r.selectors).join("\n")).not.toContain(".rowActs:focus-within");
  });

  it("are revealed by the keyboard reaching the ROW", () => {
    expect(revealSelectors()).toContain(".row:focus-within .rowActs");
  });

  // The mark and the button say the same thing, so they are never both out: whatever
  // reveals `.rowActs` has to hide `.linked`. Left on `.rowActs:focus-within`, the mark
  // would stay put and sit beside the button it duplicates.
  it("and the mark they replace steps aside on the same condition", () => {
    const hidden = rules()
      .filter((r) => /display:\s*none/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(hidden).toContain(".row:focus-within .linked:not(.linkedStarted)");
  });
});

// ---- the DOM ------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let closed: number;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  closed = 0;
  state.briefing = undefined;
  useConversationsStore.setState({ conversations: [conv()] });
  localStorage.clear();
  useTosseFold.setState({ folded: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationsStore.setState({ conversations: [] });
  vi.clearAllMocks();
});

/** The task detail panel — where the conversations of a task live. */
function renderDetail() {
  act(() =>
    root.render(
      createElement(TaskDetail, { taskId: TASK, embedded: true, onClose: () => (closed += 1) }),
    ),
  );
}

/** The board, with one project-less task — where `.row` / `.rowActs` live. */
function renderBoard() {
  state.briefing = {
    projects: [],
    pausedProjects: [],
    generalTasks: [
      {
        id: "g-1",
        title: "Déclarer l'URSSAF",
        status: "À faire",
        priority: "Moyenne",
        kind: "Admin",
        assignedTo: "Alexandre",
        dueDate: null,
        notes: null,
        subtaskCount: 0,
        subtaskDone: 0,
      } satisfies TosseTask,
    ],
  };
  act(() => root.render(createElement(TosseView, { onOpenConversation: () => {} })));
}

// Found by accessible name / role rather than by class: CSS-module names are hashed at
// build time.
const rowButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[title^="Open «"]')];
const rowButtonFor = (name: string) =>
  rowButtons().find((b) => b.title.includes(name)) ?? null;
const unlinkButtonFor = (name: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="Unlink « ${name} »"]`);
const convSection = () => container.querySelector("section");
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const scrim = () => dialog()?.parentElement ?? null;
const confirmButton = () =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === "Unlink",
  ) ?? null;

/** Enter on a focused native button, as the browser delivers it: `keydown` first, then the
 *  click it synthesises. The keydown is what tells the panel this is a keyboard user. */
function activateWithKeyboard(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    el.click();
  });
}

/** A mouse press on `el`: the press lands before the click, which is the whole reason the
 *  modality can be read at all. */
function activateWithPointer(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.click();
  });
}

/** Escape, as the dialog hears it: its handler sits on `document`. */
function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

// The premise the `.row:focus-within .rowActs` rule stands on, and the reason that remedy
// works here while it could not have worked on a box with no focusable ancestor: the row
// really is focusable itself, it really does carry a focusable child that is NOT hidden,
// and the actions really are inside it.
//
// ⚠️ Both of these are `guardrail:` — they held before the stylesheet was touched and they
// hold after, so neither PROVES the fix. They fence what the fix RELIES on: the day the row
// stops being a `role="button" tabindex="0"`, or the actions move out from under it, the
// reveal silently goes back to being unreachable and nothing else in the suite would notice.
describe("the task row that reveals its actions", () => {
  it("guardrail: the row is focusable itself, and carries a never-hidden focusable child", () => {
    renderBoard();
    const row = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Déclarer l'URSSAF");
    // The status dot: a real <button>, always in the layout, so `:focus-within` on the row
    // is reachable even before the hidden box comes back.
    expect(row!.querySelector("button[title*='change status']")).not.toBeNull();
  });

  it("guardrail: the row contains the actions box, so :focus-within covers the buttons too", () => {
    renderBoard();
    const row = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]')!;
    const discuss = [...row.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Discuss",
    );
    expect(discuss).toBeDefined();
    const acts = discuss!.parentElement!;
    expect(acts.className).toContain("rowActs");
    expect(row.contains(acts)).toBe(true);
    expect(acts).not.toBe(row);
  });
});

describe("unlinking a conversation with the keyboard", () => {
  it("guardrail: the × is a real button with an accessible name", () => {
    // Non-regression fence only: jsdom applies no CSS modules, so `focus()` would succeed
    // on a `display: none` button too — this can NOT prove reachability (the stylesheet
    // tests above do that). What it does hold onto is that the control is a native
    // <button> carrying its own name, so Enter and Space activate it for free.
    renderDetail();
    const unlink = unlinkButtonFor("Keyboard unlink");
    expect(unlink).not.toBeNull();
    expect(unlink!.tagName).toBe("BUTTON");
    expect(unlink!.disabled).toBe(false);
  });

  it("guardrail: the confirmation opens with the keyboard already on its confirm button", () => {
    // ConfirmDialog's own `autoFocus`, not this view's code — fenced here because every
    // focus assertion below is written on top of it.
    renderDetail();
    act(() => unlinkButtonFor("Keyboard unlink")!.click());
    expect(dialog()?.textContent).toContain("Unlink « Keyboard unlink » from this task?");
    expect(document.activeElement).toBe(confirmButton());
  });

  // Backing out has to leave the keyboard somewhere: the × is hidden again the moment focus
  // leaves the row, so the ROW is what gets it back. Without the fix this landed on <body>
  // and the user had to tab in from the top of the panel.
  it("hands the keyboard back to the row when Escape dismisses the confirmation", () => {
    renderDetail();
    const row = rowButtonFor("Keyboard unlink");
    act(() => unlinkButtonFor("Keyboard unlink")!.click());
    pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
    // …and the panel stays open: the dialog owns that Escape, one key closes one layer.
    expect(closed).toBe(0);
  });

  // The other side of the same coin. Focusing the row also REVEALS its × (the reveal hangs
  // off `.convItem:focus-within`), so doing it after a MOUSE dismissal lights a row up under
  // a pointer that has long left it — a hover state with nothing hovering. A pointer user
  // keeps the browser's own outcome instead.
  it("does NOT grab the row back when the mouse dismisses the confirmation", () => {
    renderDetail();
    const row = rowButtonFor("Keyboard unlink");
    act(() => unlinkButtonFor("Keyboard unlink")!.click());
    activateWithPointer(scrim()!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).not.toBe(row);
    expect(document.activeElement).toBe(document.body);
  });

  it("guardrail: confirming actually drops the link", () => {
    // Fence only: the write itself predates every keyboard fix in this file.
    renderDetail();
    act(() => unlinkButtonFor("Keyboard unlink")!.click());
    act(() => confirmButton()!.click());
    expect(useConversationsStore.getState().conversations[0].tosseTaskId).toBeNull();
    expect(unlinkButtonFor("Keyboard unlink")).toBeNull();
  });

  // The confirmed unlink takes the row the confirmation came from with it, so handing the
  // keyboard back THERE drops it on <body>: every unlink cost the user a walk back in from
  // the top of the document. It goes to a neighbour that survives instead.
  it("moves the keyboard to the neighbouring conversation once the row is gone", () => {
    useConversationsStore.setState({
      conversations: [
        conv({ id: "c1", name: "First", lastActivityAt: 2 }),
        conv({ id: "c2", name: "Second", lastActivityAt: 1 }),
      ],
    });
    renderDetail();
    const second = rowButtonFor("Second");
    act(() => unlinkButtonFor("First")!.click());
    activateWithKeyboard(confirmButton()!);
    expect(rowButtonFor("First")).toBeNull();
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(document.body);
  });

  // …and when it was the LAST one the whole section unmounts, so there is no neighbour to
  // fall back on: the panel's scroll box takes the keyboard (`tabIndex={-1}`, put there for
  // exactly this), which keeps the next Tab inside the panel.
  it("moves the keyboard to the panel when the last conversation is unlinked", () => {
    renderDetail();
    const panel = convSection()!.parentElement;
    expect(panel).not.toBeNull();
    act(() => unlinkButtonFor("Keyboard unlink")!.click());
    activateWithKeyboard(confirmButton()!);
    expect(convSection()).toBeNull(); // the list really is gone
    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(document.body);
  });
});
