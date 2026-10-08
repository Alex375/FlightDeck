// Keyboard behaviour of the shared reorder wiring, rendered through react-dom/client and
// built with createElement so the file stays a `*.test.ts` (the vitest glob), no JSX.
//
// The whole row/card is the drag surface (no grip handle), so the sortable `listeners` sit
// on an element that CONTAINS buttons. A keyboard sensor there would see the Enter/Space
// keydown bubbling up from a focused child button, `preventDefault()` it and start a
// keyboard drag — the button never fires. What is locked here: those keys reach the
// button untouched, and no drag starts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import type { RepoGroup } from "../store/conversationsStore";
import { useSurfaceOrderDnd, type DragData } from "./orderDnd";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const GROUPS = [
  { repo: { id: "r1" }, conversations: [{ id: "c1", repoId: "r1" }] },
] as unknown as RepoGroup[];

/** A whole-row drag surface with a button inside, wired exactly like the sidebar row. */
function Row(): ReactNode {
  const { listeners, setNodeRef } = useSortable({
    id: "c1",
    data: { kind: "conv", repoId: "r1" } satisfies DragData,
  });
  return createElement(
    "div",
    { ref: setNodeRef, "data-row": "", ...listeners },
    createElement("button", { type: "button" }, "open"),
  );
}

function Host({ onDragStart }: { onDragStart: () => void }): ReactNode {
  const dnd = useSurfaceOrderDnd("sidebar", GROUPS);
  return createElement(
    DndContext,
    {
      sensors: dnd.sensors,
      onDragStart: (e) => {
        onDragStart();
        dnd.onDragStart(e);
      },
      onDragEnd: dnd.onDragEnd,
      onDragCancel: dnd.onDragCancel,
    },
    createElement(SortableContext, { items: ["c1"], children: createElement(Row) }),
  );
}

describe("useSurfaceOrderDnd — keyboard on a child button", () => {
  it.each([
    ["Enter", "Enter"],
    [" ", "Space"],
  ])("leaves %j to the focused button instead of starting a drag", (key, code) => {
    const onDragStart = vi.fn();
    act(() => root.render(createElement(Host, { onDragStart })));
    const button = container.querySelector("button")!;
    button.focus();

    const keydown = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(keydown);
    });

    // A prevented keydown is what kills the browser's native button activation.
    expect(keydown.defaultPrevented).toBe(false);
    expect(onDragStart).not.toHaveBeenCalled();
  });
});
