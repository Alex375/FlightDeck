// Clean output must offer the SAME drop-this-pending-message affordance as the expanded
// bubble (MsgUser) — the explicit requirement of this feature. In clean output a message
// injected mid-turn renders ONLY as `InlineUserMarker`, so if the cross lived only on the
// full bubble, a user working in clean mode could never pull a pending message back.
//
// Locks the render gating of that cross: it appears exactly when the message is BOTH still
// queued AND addressable on the wire (our uuid), and disappears the moment either is false —
// mirroring `TurnRow`'s `wireUuid = queued ? turn.wireUuid : undefined`. A turn already
// delivered (badge cleared), or one with no uuid of ours (disk/remote/Codex), must not offer
// a cross: cancelling a message the binary has started answering wedges the session.
//
// Rendered through react-dom/client (not renderToStaticMarkup): zustand's SSR path feeds
// `useSyncExternalStore` the store's INITIAL state, so a server render can never observe the
// seeded turn. Wrapped in a QueryClientProvider because the marker now mounts the cancel
// mutation (useMutation). `*.test.ts` (the vitest glob) → elements built with createElement.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineUserMarker } from "./ConductorThread";
import { useConversationStore } from "../../store/conversationStore";

const SESSION = "inline-cancel";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

const store = () => useConversationStore.getState();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useConversationStore.setState({ sessions: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationStore.setState({ sessions: {} });
});

function mount(turnId: string) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(InlineUserMarker, { session: SESSION, turnId }),
      ),
    );
  });
}

/** The clean-output cancel cross, found by its stable aria-label rather than a hashed class. */
function cancelCross(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Remove this pending message"]');
}

/** Flip a turn out of the queued state, the way a delivery boundary does (clearQueuedBadges). */
function deliver(turnId: string) {
  act(() => {
    useConversationStore.setState((s) => {
      const entry = s.sessions[SESSION];
      const turn = entry.turns[turnId];
      return {
        sessions: {
          ...s.sessions,
          [SESSION]: { ...entry, turns: { ...entry.turns, [turnId]: { ...turn, queued: false } } },
        },
      };
    });
  });
}

describe("InlineUserMarker — cancel affordance in clean output", () => {
  it("offers the cross once the message is queued AND addressable on the wire", () => {
    const id = store().addUserTurn(SESSION, "hold on", true);
    store().setTurnWireUuid(SESSION, id, "uuid-77");
    mount(id);

    expect(container.textContent).toContain("pending");
    expect(cancelCross()).not.toBeNull();
  });

  it("shows no cross while the message is queued but not yet addressable (no uuid of ours)", () => {
    // Disk-restored / remote / Codex turns carry no uuid: there is nothing to name in the
    // binary's queue, so the affordance must be withheld — as it is on the full bubble.
    const id = store().addUserTurn(SESSION, "hold on", true);
    mount(id);

    expect(container.textContent).toContain("pending");
    expect(cancelCross()).toBeNull();
  });

  it("drops the cross the moment the message is delivered, even with a uuid still attached", () => {
    // Cancelling a message the binary has begun answering wedges the session (no `result`
    // ever follows). Delivery clears the badge → the affordance goes with it.
    const id = store().addUserTurn(SESSION, "hold on", true);
    store().setTurnWireUuid(SESSION, id, "uuid-77");
    deliver(id);
    mount(id);

    expect(container.textContent).toContain("Message sent");
    expect(cancelCross()).toBeNull();
  });
});
