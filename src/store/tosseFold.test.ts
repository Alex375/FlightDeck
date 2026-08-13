import { beforeEach, describe, expect, it } from "vitest";
import {
  backlogFoldKey,
  GENERAL_FOLD_KEY,
  offBoardFold,
  pendingFoldKey,
  projectFoldKey,
  useTosseFold,
} from "./tosseFold";

const STORAGE_KEY = "tosse:fold";

const stored = (): Record<string, boolean> =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, boolean>;

beforeEach(() => {
  localStorage.clear();
  useTosseFold.setState({ folded: {} });
});

describe("tosse fold keys", () => {
  // The whole view shares ONE map, so a client id and a project id — both bare CRM uuids —
  // must not land on the same key. Folding a client would otherwise fold a project too.
  it("keeps client, project, backlog and general keys in disjoint namespaces", () => {
    const id = "5f0e2a3c-1111-2222-3333-444455556666";
    const keys = [id, projectFoldKey(id), backlogFoldKey(id), GENERAL_FOLD_KEY];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prefixes a project key so it can never be a bare client id", () => {
    expect(projectFoldKey("abc")).toBe("project:abc");
  });
});

describe("offBoardFold", () => {
  it("gives the two known sections their namespace and their own default", () => {
    // Opposite on purpose: a parked-but-waiting task is live work whose ball is in someone
    // else's court, a backlog item is work deliberately not started.
    expect(offBoardFold("En attente")).toEqual({ key: pendingFoldKey, defaultOpen: true });
    expect(offBoardFold("Backlog")).toEqual({ key: backlogFoldKey, defaultOpen: false });
  });

  it("gives a status it has never seen a namespace of its OWN, not « En attente »'s", () => {
    // The off-board status list belongs to the CRM server, so it can grow without this file
    // being touched. The old `else` branch was not a default but a COLLISION: a third section
    // shared `pending:<projectId>`, so collapsing either folded both on every card, and
    // `aria-expanded` lied on one of them.
    const third = offBoardFold("Bloqué");
    expect(third.key("p1")).not.toBe(pendingFoldKey("p1"));
    expect(third.key("p1")).not.toBe(backlogFoldKey("p1"));
    expect(offBoardFold("Autre").key("p1")).not.toBe(third.key("p1"));
    // …and it stays visible by default: this store records what is CLOSED, so the safe
    // direction for a section nobody has ruled on is open.
    expect(third.defaultOpen).toBe(true);
  });
});

describe("useTosseFold", () => {
  it("stores ONLY what is folded, so an untouched project stays open", () => {
    const key = projectFoldKey("p1");
    expect(useTosseFold.getState().folded[key]).toBeUndefined();

    useTosseFold.getState().toggle(key);
    expect(useTosseFold.getState().folded[key]).toBe(true);

    useTosseFold.getState().toggle(key);
    // Deleted, not set to false: an open band leaves no trace at all.
    expect(key in useTosseFold.getState().folded).toBe(false);
  });

  it("persists across a reload, and unfolding removes the entry from storage", () => {
    const key = projectFoldKey("p1");
    useTosseFold.getState().toggle(key);
    expect(stored()).toEqual({ [key]: true });

    useTosseFold.getState().toggle(key);
    expect(stored()).toEqual({});
  });

  it("folds a project without touching the client band it sits in", () => {
    const client = "client-1";
    const project = projectFoldKey("p1");
    useTosseFold.getState().toggle(project);
    expect(useTosseFold.getState().folded[client]).toBeUndefined();

    useTosseFold.getState().toggle(client);
    // Both folded, independently — the client's fold hides the projects on screen, and each
    // project's own state is restored when it is opened again.
    expect(useTosseFold.getState().folded).toEqual({ [project]: true, [client]: true });
  });
});
