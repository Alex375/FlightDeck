// What the delete confirmation actually says.
//
// The dialog is deliberately terse: one short line for a live run, and the linked task as a
// SNIPPET (title + status badge). The regression this locks is the one it was rewritten out
// of — three sentences of reassurance about what deleting does NOT touch, which is what
// trains a user to click through a destructive dialog without reading it.
//
// Rendered through react-dom/client rather than renderToStaticMarkup: the dialog goes out
// through a portal, which the server renderer refuses.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeleteConversationDialog } from "./DeleteConversationDialog";
import type { DeleteReason } from "./deleteGuard";
import type { Conversation } from "../../store/conversationsStore";
import { tosseStatusKey } from "../../ipc/useTosse";
import { useEditorStore } from "../editor/editorStore";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Seeded rather than fetched: the dialog only asks whether a CRM session exists, and the
  // command behind it is not what these assertions are about.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setConnected(true);
});

function setConnected(connected: boolean) {
  qc.setQueryData(tosseStatusKey(), {
    connected,
    name: null,
    email: null,
    signedOutReason: null,
    identityError: null,
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useEditorStore.getState().closeTosseTask();
});

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    name: "Delete guard",
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
    tosseTaskId: null,
    tosseTaskTitle: null,
    tosseTaskStatus: null,
    cleanOutput: null,
    kind: "claude",
    ...over,
  };
}

/** Mount the dialog. It portals to `document.body`, not into our container. */
function mount(
  reason: DeleteReason,
  over: Partial<Conversation> = {},
  props: {
    onShowConversation?: (id: string) => void;
    onCancel?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(DeleteConversationDialog, {
          conv: conv(over),
          reason,
          onCancel: props.onCancel ?? (() => {}),
          onConfirm: () => {},
          onShowConversation: props.onShowConversation,
        }),
      ),
    );
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="alertdialog"]');
}

/** The dialog's rendered text. */
function render(reason: DeleteReason, over: Partial<Conversation> = {}): string {
  mount(reason, over);
  return dialog()?.textContent ?? "";
}

/** The task row IF it rendered as a button — i.e. if it offers to open the task. Found by
 *  its text rather than by a class, since CSS-module names are hashed at build time. */
function taskButton(title: string): HTMLButtonElement | null {
  const buttons = [...(dialog()?.querySelectorAll("button") ?? [])];
  return buttons.find((b) => b.textContent?.includes(title)) ?? null;
}

const linked = { tosseTaskId: "t-1", tosseTaskTitle: "Fix the login bug", tosseTaskStatus: "Review" };

describe("DeleteConversationDialog", () => {
  it("names the conversation and offers a destructive confirm", () => {
    const text = render("running");
    expect(text).toContain('Delete "Delete guard"?');
    expect(text).toContain("Delete anyway");
    expect(text).toContain("Cancel");
  });

  it("says a live run stops, in one line, naming the backend", () => {
    expect(render("running")).toContain("Running — this stops the Claude session.");
    expect(render("running", { kind: "codex" })).toContain(
      "Running — this stops the Codex session.",
    );
  });

  it("shows the linked task as a title plus its status, and says nothing else", () => {
    const text = render("linkedTask", linked);
    expect(text).toContain("Fix the login bug");
    expect(text).toContain("Review");
    // No run to warn about, so no run sentence.
    expect(text).not.toContain("Running");
    // The prose the rewrite removed. A confirmation is read in the second before a click;
    // reassurance about what is NOT touched belongs nowhere near it.
    expect(text).not.toMatch(/stays exactly as it is|⌘Z|recovered/);
  });

  it("states both reasons in one dialog, never two questions in a row", () => {
    const text = render("both", linked);
    expect(text).toContain("Running — this stops the Claude session.");
    expect(text).toContain("Fix the login bug");
  });

  // The title is the CRM's, and it can be missing (a link stamped before the title was
  // known, or a payload that dropped it): the row still has to say what it is about.
  it("falls back to a generic label when the task title is unknown", () => {
    const text = render("linkedTask", { tosseTaskId: "t-1", tosseTaskStatus: "En cours" });
    expect(text).toContain("A TOSSE task");
    expect(text).toContain("En cours");
  });
});

describe("DeleteConversationDialog — opening the task", () => {
  const title = "Fix the login bug";

  it("brings the conversation on screen, then opens its task beside it", () => {
    const shown: string[] = [];
    let cancelled = 0;
    mount("linkedTask", linked, {
      onShowConversation: (id) => shown.push(id),
      onCancel: () => cancelled++,
    });
    const button = taskButton(title);
    expect(button).not.toBeNull();
    act(() => button!.click());

    // Cancelled FIRST: going to read the task is deciding not to delete right now. Leaving
    // the dialog up over the panel it just opened would ask the question twice.
    expect(cancelled).toBe(1);
    expect(shown).toEqual(["c1"]);
    expect(useEditorStore.getState().tosseTaskView).toEqual({ convId: "c1", taskId: "t-1" });
  });

  // A surface with nowhere to send the user must not render a link that does nothing.
  it("states the task plainly when the caller cannot show the conversation", () => {
    mount("linkedTask", linked);
    expect(taskButton(title)).toBeNull();
    expect(dialog()?.textContent).toContain(title);
  });

  // Reading a task needs a live CRM session; without one the panel could only load an error.
  it("states the task plainly while signed out of TOSSE", () => {
    setConnected(false);
    mount("linkedTask", linked, { onShowConversation: () => {} });
    expect(taskButton(title)).toBeNull();
    expect(dialog()?.textContent).toContain(title);
  });
});
