// "Accept the plan" switches the conversation to Auto only once claude TOOK that approval — the
// plan's tool_result reads "approved". The answer IPC resolves when the answer is queued, which
// says nothing of whether it was used: on a remote conversation the phone's rejection may have
// won, or the held answer may be dropped at reattach. Switching then left plan mode without an
// approved plan, and the agent could edit files.
//
// Rendered through react-dom/client in a QueryClientProvider (the card mounts the answer
// mutation); `*.test.ts` (the vitest glob) → elements built with createElement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => {
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  const commands = new Proxy(fns, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => ok(null))),
  });
  return { fns, commands };
});

vi.mock("../../ipc/client", () => ({ commands: mocks.commands, events: {} }));

import type { ConversationItem } from "../../ipc/client";
import { PlanCard } from "./PlanCard";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";

const S = "plan-conv";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no `CSS` namespace (the card's inline highlights read `CSS.highlights`).
  (globalThis as { CSS?: object }).CSS ??= {};
  for (const fn of Object.values(mocks.fns)) fn.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useConversationStore.setState({ sessions: {} });
  useConversationsStore.setState({
    conversations: [
      { id: S, repoId: "r1", cwd: "/srv/app", name: "p", kind: "claude", handle: "session-1", permissionMode: "plan" },
    ] as never,
  });
  useConversationStore.getState().enqueuePermission(S, {
    request_id: "req-1",
    tool_name: "ExitPlanMode",
    tool_use_id: "plan1",
    input: { plan: "1. Change the schema" },
    title: null,
    description: null,
    suggestions: [],
    blocked_path: null,
    decision_reason: null,
    agent_id: null,
  } as never);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(PlanCard, { session: S, toolUseId: "plan1", input: { plan: "1. Change the schema" } }),
      ),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mode = () => useConversationsStore.getState().conversations.find((c) => c.id === S)!.permissionMode;

async function acceptThePlan() {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Accept the plan"));
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const planResult = (text: string, isError: boolean) =>
  act(() => {
    useConversationStore
      .getState()
      .applyItem(S, { kind: "tool_result", tool_use_id: "plan1", content: text, is_error: isError, parent_tool_use_id: null } as ConversationItem);
  });

describe("accepting a plan", () => {
  it("does not switch to Auto when the answer is merely queued", async () => {
    await acceptThePlan();
    expect(mocks.commands.answerPermission).toHaveBeenCalledWith("session-1", "req-1", { behavior: "allow", updated_input: null });
    expect(mode()).toBe("plan");
    expect(mocks.commands.setPermissionMode).not.toHaveBeenCalled();
  });

  it("switches to Auto once claude took the approval", async () => {
    await acceptThePlan();
    planResult("User has approved your plan. You can now start coding.", false);
    expect(mode()).toBe("auto");
    expect(mocks.commands.setPermissionMode).toHaveBeenCalledWith("session-1", "auto");
  });

  it("stays out of Auto when another device's rejection won", async () => {
    await acceptThePlan();
    planResult("Don't touch the schema.", true);
    expect(mode()).toBe("plan");
    expect(mocks.commands.setPermissionMode).not.toHaveBeenCalled();
  });
});
