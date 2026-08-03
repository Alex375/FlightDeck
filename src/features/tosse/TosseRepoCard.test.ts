// The regression an adversarial review caught, locked down: when the CRM's repository list
// cannot be READ, the card must not diagnose the association.
//
// Resolving against an empty list made "we could not look" identical to "we looked and
// found nothing". The card then stated, on the same screen as the real cause, that the
// repository the user had pinned "is gone — it may have been archived or deleted", and
// offered exactly one enabled control: "Clear association" (the picker needs a repository
// list, so it was disabled). A 30-second outage was enough to talk the user into destroying
// a valid, deliberate association — no confirmation, no undo.
//
// Renders through react-dom/client (NOT renderToStaticMarkup): zustand's SSR path feeds
// `useSyncExternalStore` the store's INITIAL state, so a server render could not observe
// the store reads this component makes. Lives in a `*.test.ts` file (the vitest glob), so
// elements are built with createElement — no JSX.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TosseRepoLink, TosseRepoLinksPayload, TosseRepository } from "../../ipc/client";

// The card reads its data through this hook; driving the hook lets us reproduce a payload
// the mock IPC never produces (a reachable session whose repository list failed to load).
const state = {
  payload: undefined as TosseRepoLinksPayload | undefined,
};

vi.mock("../../ipc/useTosse", () => ({
  useTosseRepoLinks: () => ({
    data: state.payload,
    isFetching: false,
    refetch: () => Promise.resolve(),
    error: null,
  }),
  repoLinkFor: (payload: TosseRepoLinksPayload | undefined, repoId: string) =>
    payload?.links.find((l) => l.repoId === repoId),
  useLinkTosseRepository: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

// The opener plugin has no Tauri host under vitest.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TosseRepoCard } from "./TosseRepoCard";
import { useTosseRepoUi } from "./tosseRepoUiStore";
import { useConversationsStore } from "../../store/conversationsStore";

const REPO_ID = "repo-1";

const repository: TosseRepository = {
  id: "r-picked",
  name: "TOSSE",
  url: "https://github.com/Alex375/CRM_max",
  host: "github",
  status: "Actif",
  context: null,
  projects: [],
};

function link(over: Partial<TosseRepoLink> = {}): TosseRepoLink {
  return {
    repoId: REPO_ID,
    resolved: true,
    remoteUrl: "git@github.com:Alex375/CRM_max.git",
    repository: null,
    source: null,
    manualRepositoryId: null,
    ambiguous: [],
    remoteError: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The card resolves the folder's path from the repo store.
  useConversationsStore.setState({
    repos: [{ id: REPO_ID, path: "/Users/dev/Repos/CRM_max", addedAt: 0 }],
  });
  useTosseRepoUi.getState().openCard(REPO_ID);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTosseRepoUi.getState().closeCard();
  useConversationsStore.setState({ repos: [] });
});

function render(payload: TosseRepoLinksPayload) {
  state.payload = payload;
  act(() => {
    root.render(createElement(TosseRepoCard));
  });
  return container.textContent ?? "";
}

/** The "Clear association" button, when the card renders one. */
function clearButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Clear association"),
  ) as HTMLButtonElement | undefined;
}

describe("TosseRepoCard when the CRM list could not be read", () => {
  const unreadable: TosseRepoLinksPayload = {
    connected: true,
    error: "TOSSE answered HTTP 502: Bad Gateway",
    repositories: [],
    // What the backend now returns in this case: no verdict, the user's pin preserved.
    links: [link({ resolved: false, manualRepositoryId: "r-picked" })],
  };

  it("says the check could not run, and states nothing about the association", () => {
    const text = render(unreadable);
    expect(text).toContain("TOSSE could not be read");
    expect(text).toContain("has not been checked yet");
    // The two false diagnoses that cost a valid association.
    expect(text).not.toContain("is gone");
    expect(text).not.toContain("archived or deleted");
    expect(text).not.toContain("not associated with TOSSE");
  });

  it("does not offer destroying the association as the way out", () => {
    render(unreadable);
    const clear = clearButton();
    // Present (the pin exists) but inert, with the reason in VISIBLE text — a disabled
    // control has no pointer events, so a `title` would never render.
    expect(clear?.disabled).toBe(true);
    expect(container.textContent).toContain("unavailable until TOSSE can be reached");
  });
});

describe("TosseRepoCard when the CRM list WAS read", () => {
  it("still reports a genuinely deleted repository, and lets the user clear it", () => {
    // Same shape as the outage above — except the list was actually read. Here the verdict
    // is real, and the destructive action is legitimately available.
    const text = render({
      connected: true,
      error: null,
      repositories: [repository],
      links: [link({ resolved: true, manualRepositoryId: "r-deleted" })],
    });
    expect(text).toContain("The repository you picked is gone");
    expect(clearButton()?.disabled).toBe(false);
  });

  it("reports a folder that matches nothing as un-associated", () => {
    const text = render({
      connected: true,
      error: null,
      repositories: [repository],
      links: [link({ resolved: true })],
    });
    expect(text).toContain("This folder is not associated with TOSSE");
    expect(text).toContain("No TOSSE repository carries this folder's remote");
  });

  it("blames the unreadable remote rather than the folder when git itself failed", () => {
    const text = render({
      connected: true,
      error: null,
      repositories: [repository],
      links: [
        link({ resolved: true, remoteUrl: null, remoteError: "fatal: not a git repository" }),
      ],
    });
    expect(text).toContain("git remote could not be read");
    // The claim that would send the user hunting for a missing remote on a broken checkout.
    expect(text).not.toContain("This folder has no git remote");
  });
});

describe("TosseRepoCard for a folder added since the last fetch", () => {
  it("says it has not been checked instead of asserting anything about its remote", () => {
    const text = render({
      connected: true,
      error: null,
      repositories: [repository],
      links: [], // no entry for REPO_ID
    });
    expect(text).toContain("has not been checked yet");
    expect(text).not.toContain("This folder has no git remote");
  });
});
