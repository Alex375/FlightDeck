// The clean-output exit choreography. Two things are being locked here:
//  - the pure bookkeeping (who is leaving, in what order, until when);
//  - the property the whole animation depends on: the leaving item's DOM node SURVIVES the
//    cut. A transition needs a node that was already painted in its open state, so if React
//    unmounts and re-mounts it, the CSS never runs and the feature silently degrades to the
//    cut it was meant to replace. Mounted under StrictMode on purpose — the state is adjusted
//    DURING render, which double-invocation would break if it were derived from a mutable ref.
//
// Rendered through react-dom/client (not renderToStaticMarkup): the behaviour is entirely
// about successive renders. `*.test.ts` (the vitest glob) → elements built with createElement.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EXIT_MS,
  EXIT_MAX_SLOTS,
  EXIT_STAGGER_MS,
  computeExits,
  exitDelayMs,
  heldVisibleStart,
  sameKeys,
  useWorkExit,
} from "./cleanExit";
import { atomsToSegments, type WorkAtom } from "./toolGroup";

describe("exitDelayMs", () => {
  it("staggers by slot and caps so a big batch cannot animate forever", () => {
    expect(exitDelayMs(0)).toBe(0);
    expect(exitDelayMs(2)).toBe(2 * EXIT_STAGGER_MS);
    expect(exitDelayMs(EXIT_MAX_SLOTS)).toBe(EXIT_MAX_SLOTS * EXIT_STAGGER_MS);
    // Past the cap the tail leaves WITH the last staggered item.
    expect(exitDelayMs(EXIT_MAX_SLOTS + 7)).toBe(EXIT_MAX_SLOTS * EXIT_STAGGER_MS);
  });
});

describe("sameKeys", () => {
  it("compares by content and order", () => {
    expect(sameKeys(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameKeys(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameKeys(["a"], ["a", "b"])).toBe(false);
  });
});

describe("computeExits", () => {
  const folded = (...keys: string[]) => new Set(keys);

  it("holds the atoms that crossed into the fold, oldest first", () => {
    const held = computeExits({
      prevVisible: ["a", "b", "c"],
      visibleNow: ["c"],
      folded: folded("a", "b"),
      held: [],
      now: 1000,
    });
    expect(held.map((h) => h.key)).toEqual(["a", "b"]);
    expect(held.map((h) => h.slot)).toEqual([0, 1]);
    // ONE deadline for the batch, set by its LAST slot — see the atomicity test below.
    const deadline = 1000 + EXIT_MS + EXIT_STAGGER_MS;
    expect(held.map((h) => h.expiresAt)).toEqual([deadline, deadline]);
  });

  it("never holds an atom the caller vetoes", () => {
    // A plan / artifact / question is rendered in clear on the other side, so it does not
    // leave the flow at all — holding it would put the same card on screen twice.
    const held = computeExits({
      prevVisible: ["a", "plan", "c"],
      visibleNow: ["c"],
      folded: folded("a", "plan"),
      held: [],
      now: 0,
      holdable: (k) => k !== "plan",
    });
    expect(held.map((h) => h.key)).toEqual(["a"]);
  });

  it("ignores an atom that vanished from the round instead of folding", () => {
    // A reload / rewind rebuilds the atom list: the atom is in neither side. Animating it out
    // would fly a row that no longer belongs to the conversation.
    const held = computeExits({
      prevVisible: ["a", "b"],
      visibleNow: ["b"],
      folded: folded(),
      held: [],
      now: 0,
    });
    expect(held).toEqual([]);
  });

  it("keeps live holds, drops expired ones, and never re-holds the same atom", () => {
    const held = computeExits({
      prevVisible: ["b", "c"],
      visibleNow: ["c"],
      folded: folded("a", "b"),
      held: [
        { key: "a", slot: 0, expiresAt: 500 }, // still flying
        { key: "z", slot: 1, expiresAt: 100 }, // expired
      ],
      now: 200,
    });
    expect(held.map((h) => h.key)).toEqual(["a", "b"]);
    // The new batch starts its own stagger at slot 0.
    expect(held[1].slot).toBe(0);
  });

  it("drops a hold whose atom came back into the clear zone", () => {
    const held = computeExits({
      prevVisible: ["b"],
      visibleNow: ["a", "b"],
      folded: folded(),
      held: [{ key: "a", slot: 0, expiresAt: 9999 }],
      now: 0,
    });
    expect(held).toEqual([]);
  });

  it("never lets a later batch expire before one that is already in the air", () => {
    // A big batch leaves at t=0 (6 atoms → 180ms + a 175ms stagger tail = t+355), then a lone
    // atom crosses at t=50 (t+230). Retiring the LATER one first empties the rendered clear
    // zone from the cut backwards, taking the earlier batch out mid-transition — so its
    // deadline is clamped to the batch already flying.
    const first = computeExits({
      prevVisible: ["a", "b", "c", "d", "e", "f", "g"],
      visibleNow: ["g"],
      folded: folded("a", "b", "c", "d", "e", "f"),
      held: [],
      now: 0,
    });
    const batchDeadline = first[0].expiresAt;
    expect(batchDeadline).toBe(EXIT_MS + exitDelayMs(5));

    const second = computeExits({
      prevVisible: ["g"],
      visibleNow: [],
      folded: folded("a", "b", "c", "d", "e", "f", "g"),
      held: first,
      now: 50,
    });
    const late = second.find((h) => h.key === "g");
    expect(late?.expiresAt).toBe(batchDeadline);
    expect(Math.min(...second.map((h) => h.expiresAt))).toBe(batchDeadline);
  });
});

describe("heldVisibleStart", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("is the plain cut when nothing is held", () => {
    expect(heldVisibleStart(keys, 3, [])).toBe(3);
  });

  it("walks back over the contiguous held tail of the folded side", () => {
    const held = [
      { key: "b", slot: 0, expiresAt: 1 },
      { key: "c", slot: 1, expiresAt: 1 },
    ];
    expect(heldVisibleStart(keys, 3, held)).toBe(1);
  });

  it("stops at a non-held atom instead of dragging older work back into the clear", () => {
    const held = [{ key: "c", slot: 0, expiresAt: 1 }];
    expect(heldVisibleStart(keys, 3, held)).toBe(2);
  });
});

// ---- The hook, in a real DOM ------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Harness({
  keys,
  split,
  enabled,
  holdable,
}: {
  keys: string[];
  split: number;
  enabled: boolean;
  holdable?: (key: string) => boolean;
}) {
  const { visStart, slots } = useWorkExit(keys, split, enabled, holdable);
  return createElement(
    "div",
    null,
    keys.slice(visStart).map((k) =>
      createElement("div", {
        key: k,
        "data-k": k,
        "data-slot": slots.has(k) ? String(slots.get(k)) : undefined,
      }),
    ),
  );
}

function render(props: {
  keys: string[];
  split: number;
  enabled: boolean;
  holdable?: (key: string) => boolean;
}) {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(Harness, props)));
  });
}

const shown = () => Array.from(container.querySelectorAll("[data-k]")).map((n) => n.getAttribute("data-k"));
const nodeFor = (k: string) => container.querySelector(`[data-k="${k}"]`);

describe("useWorkExit", () => {
  const keys = ["a", "b", "c", "d"];

  it("keeps a leaving atom rendered — on the SAME node — then releases it", () => {
    render({ keys, split: 1, enabled: true });
    expect(shown()).toEqual(["b", "c", "d"]);
    const before = nodeFor("b");

    render({ keys, split: 2, enabled: true });
    // Still rendered (it is flying out), flagged with its stagger slot…
    expect(shown()).toEqual(["b", "c", "d"]);
    expect(nodeFor("b")?.getAttribute("data-slot")).toBe("0");
    // …and it is the very node that was already painted — the transition's start value.
    expect(nodeFor("b")).toBe(before);

    act(() => void vi.advanceTimersByTime(EXIT_MS + 1));
    expect(shown()).toEqual(["c", "d"]);
  });

  it("staggers a batch in CSS but retires it atomically", () => {
    render({ keys, split: 0, enabled: true });
    render({ keys, split: 2, enabled: true });
    expect(nodeFor("a")?.getAttribute("data-slot")).toBe("0");
    expect(nodeFor("b")?.getAttribute("data-slot")).toBe("1");

    // ⚠️ The whole batch leaves together, even though slot 0 finished its own transition an
    // EXIT_STAGGER_MS ago. Retiring them one at a time would shrink the held region mid-flight,
    // and `atomsToSegments` numbers reconstructed runs by ORDINAL from its start: a still-live
    // tool section would change key and be remounted, snapping shut any row the user opened.
    // (Locked end-to-end by the "run keys are stable" test below.)
    act(() => void vi.advanceTimersByTime(EXIT_MS + 1));
    expect(shown()).toEqual(["a", "b", "c", "d"]);
    act(() => void vi.advanceTimersByTime(EXIT_STAGGER_MS + 1));
    expect(shown()).toEqual(["c", "d"]);
  });

  it("cuts straight through when disabled (a settled round moves nothing)", () => {
    render({ keys, split: 1, enabled: false });
    render({ keys, split: 3, enabled: false });
    expect(shown()).toEqual(["d"]);
  });

  it("keeps reconstructed run keys stable for the whole flight of a mixed batch", () => {
    // The regression this locks is one the harness above CANNOT see: it renders atom keys
    // directly, whereas the real clear zone goes through `atomsToSegments`, which keys a run by
    // the run it was flattened FROM. Two slice-local schemes that used to break, both locked
    // here: the run's ORDINAL in the slice, and its FIRST STEP's id (the slice's start moves as
    // work folds), plus releasing a batch atom by atom (it moves again mid-flight).
    // Either one re-keys a live, untouched run → React remounts it mid-animation and every step
    // row the user had expanded snaps shut.
    const atoms: WorkAtom[] = [
      { kind: "step", key: "s1", step: { id: "s1", name: "Read", input: null }, runKey: "run-0" },
      { kind: "text", key: "t1", text: "narration" },
      { kind: "step", key: "s2", step: { id: "s2", name: "Read", input: null }, runKey: "run-2" },
      { kind: "step", key: "s3", step: { id: "s3", name: "Edit", input: null }, runKey: "run-2" },
      { kind: "step", key: "s4", step: { id: "s4", name: "Bash", input: null }, runKey: "run-2" },
    ];
    const atomKeys = atoms.map((a) => a.key);
    const split = 2; // s1 and t1 just crossed the cut, together
    const runKeys = (start: number) =>
      atomsToSegments(atoms.slice(start), "vis")
        .filter((s) => s.kind === "run")
        .map((s) => s.key);

    const held = computeExits({
      prevVisible: atomKeys,
      visibleNow: atomKeys.slice(split),
      folded: new Set(atomKeys.slice(0, split)),
      held: [],
      now: 0,
    });
    // Everything held → the clear zone starts at the top; nothing held → it starts at the cut.
    const duringFlight = runKeys(heldVisibleStart(atomKeys, split, held));
    const afterFlight = runKeys(heldVisibleStart(atomKeys, split, []));
    // The run carrying s2/s3/s4 must answer to the SAME key in both states.
    expect(duringFlight).toContain("vis-run-2");
    expect(afterFlight).toEqual(["vis-run-2"]);

    // …and there is no in-between state where only part of the batch has been released.
    const deadlines = new Set(held.map((h) => h.expiresAt));
    expect(deadlines.size).toBe(1);
  });

  it("gives no slot to a hold the clear zone cannot reach", () => {
    // A vetoed atom (a plan/artifact/question, pulled back into clear by renderFoldedWork) sits
    // between the batch and the cut, so `heldVisibleStart` stops on it and `b` is never
    // rendered. Its slot must NOT be handed out either: the fold would grow the arriving copy
    // in over 180ms with nothing shrinking away, and the thread would jump by the row's full
    // height and climb back.
    const withPlan = ["a", "b", "P", "c"];
    const holdable = (k: string) => k !== "P";
    render({ keys: withPlan, split: 1, enabled: true, holdable });
    expect(shown()).toEqual(["b", "P", "c"]);

    render({ keys: withPlan, split: 3, enabled: true, holdable });
    expect(shown()).toEqual(["c"]);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(0);
  });

  it("does not fly out work that folded while the animation was disabled", () => {
    // The round settled (disabled) while the cut moved; going live again must not replay a
    // batch that left long ago.
    render({ keys, split: 0, enabled: false });
    render({ keys, split: 3, enabled: false });
    render({ keys, split: 3, enabled: true });
    expect(shown()).toEqual(["d"]);
  });
});
