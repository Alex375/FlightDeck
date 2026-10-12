// Settings → Control → "Let agents pilot the app": the in-app `flightdeck` MCP server is withheld
// from conversations running on a paired server (deliberate, in spawn_session). Once a server is
// paired, the setting says so — "on" must not read as covering every conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/client", () => ({ commands: {}, events: {} }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { AgentControlGroup } from "./ControlSection";

let container: HTMLDivElement;
let root: Root;
const SENTENCE = "Conversations running on a paired server don't get it";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationsStore.setState({ machines: [] });
});

describe("Agent control of the app", () => {
  it("explains the exclusion once a server is paired", () => {
    useConversationsStore.setState({ machines: [{ id: "m1", label: "Base" }] as never });
    act(() => root.render(createElement(AgentControlGroup)));
    expect(container.textContent).toContain(SENTENCE);
  });

  it("says nothing about servers when none is paired", () => {
    useConversationsStore.setState({ machines: [] });
    act(() => root.render(createElement(AgentControlGroup)));
    expect(container.textContent).not.toContain(SENTENCE);
  });
});
