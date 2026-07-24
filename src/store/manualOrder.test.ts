import { describe, it, expect } from "vitest";
import { manualComparator, manualIndex, slotFor, type OrderBlob } from "./manualOrder";
import { groupConversationsByRepoOrdered } from "./conversationsStore";
import type { Conversation, Repo } from "./conversationsStore";
import { orderLanes } from "../agent/fleet";

function repo(id: string, addedAt: number): Repo {
  return { id, path: "/r/" + id, addedAt };
}
function conv(id: string, repoId: string, lastActivityAt: number, createdAt = lastActivityAt): Conversation {
  return { id, repoId, lastActivityAt, createdAt } as unknown as Conversation;
}
const blob = (repoOrder: string[] = [], convOrder: Record<string, string[]> = {}): OrderBlob => ({
  repoOrder,
  convOrder,
});

describe("slotFor", () => {
  it("shares one slot when shared, else per-surface", () => {
    expect(slotFor("sidebar", true)).toBe("shared");
    expect(slotFor("flightdeck", true)).toBe("shared");
    expect(slotFor("sidebar", false)).toBe("sidebar");
    expect(slotFor("flightdeck", false)).toBe("flightdeck");
  });
});

describe("manualComparator", () => {
  type Item = { id: string; born: number };
  const sort = (items: Item[], order: string[]) =>
    [...items]
      .sort(manualComparator<Item>(manualIndex(order), (x) => x.id, (x) => x.born))
      .map((x) => x.id);

  it("known items follow their stored position", () => {
    const items = [{ id: "a", born: 1 }, { id: "b", born: 2 }, { id: "c", born: 3 }];
    expect(sort(items, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("unknown items go to the top, newest-born first, ahead of known ones", () => {
    const items = [{ id: "a", born: 1 }, { id: "new1", born: 5 }, { id: "b", born: 2 }, { id: "new2", born: 9 }];
    // known order = [b, a]; unknowns (new2 born9, new1 born5) prepended newest-first.
    expect(sort(items, ["b", "a"])).toEqual(["new2", "new1", "b", "a"]);
  });

  it("with no stored order everything is 'new' → newest-born first", () => {
    const items = [{ id: "a", born: 1 }, { id: "b", born: 3 }, { id: "c", born: 2 }];
    expect(sort(items, [])).toEqual(["b", "c", "a"]);
  });
});

describe("groupConversationsByRepoOrdered", () => {
  const repos = [repo("a", 1), repo("b", 2)];
  const conversations = [conv("c1", "a", 100), conv("c2", "a", 300), conv("c3", "b", 200)];

  it("all-auto reproduces recency ordering (default behaviour unchanged)", () => {
    const groups = groupConversationsByRepoOrdered(repos, conversations, blob(), true, true);
    expect(groups.map((g) => g.repo.id)).toEqual(["a", "b"]);
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("manual conversations follow the stored order, ignoring recency", () => {
    // Recency would give [c2, c1]; the manual order pins [c1, c2].
    const order = blob([], { a: ["c1", "c2"] });
    const groups = groupConversationsByRepoOrdered(repos, conversations, order, /*autoConvs*/ false, true);
    expect(groups.find((g) => g.repo.id === "a")!.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("a brand-new conversation lands on top in manual mode", () => {
    const withNew = [...conversations, conv("c9", "a", 1, /*createdAt*/ 9999)];
    const order = blob([], { a: ["c1", "c2"] }); // c9 not listed → new
    const groups = groupConversationsByRepoOrdered(repos, withNew, order, false, true);
    expect(groups.find((g) => g.repo.id === "a")!.conversations.map((c) => c.id)).toEqual(["c9", "c1", "c2"]);
  });

  it("manual repositories follow the stored order; a new repo lands first", () => {
    const withNewRepo = [...repos, repo("z", 5)]; // z not in repoOrder → new
    const order = blob(["b", "a"]);
    const groups = groupConversationsByRepoOrdered(withNewRepo, conversations, order, true, /*autoRepos*/ false);
    expect(groups.map((g) => g.repo.id)).toEqual(["z", "b", "a"]);
  });
});

describe("orderLanes with manual order", () => {
  const repos = [repo("a", 1), repo("b", 2)];
  // c-urgent has the most urgent status (rank 0) but must NOT jump the manual order.
  const conversations = [conv("c1", "a", 100), conv("c-urgent", "a", 50), conv("c3", "b", 200)];
  const rank = (c: Conversation) => (c.id === "c-urgent" ? 0 : 5);

  it("manual card order beats status; new cards go to the very start", () => {
    const withNew = [...conversations, conv("c-new", "a", 1, 9999)];
    const order = blob([], { a: ["c1", "c-urgent"] }); // c-new unlisted → new
    const lanes = orderLanes(repos, withNew, rank, { order, autoConvs: false, autoRepos: true });
    expect(lanes.find((l) => l.repo.id === "a")!.conversations.map((c) => c.id)).toEqual([
      "c-new",
      "c1",
      "c-urgent",
    ]);
  });

  it("omitting `manual` keeps the historical status-first behaviour", () => {
    const lanes = orderLanes(repos, conversations, rank);
    // c-urgent (rank 0) beats c1 (rank 5) despite lower recency.
    expect(lanes.find((l) => l.repo.id === "a")!.conversations.map((c) => c.id)).toEqual(["c-urgent", "c1"]);
  });

  it("skips the (expensive) status derivation when both levels are manual", () => {
    const order = blob(["a", "b"], { a: ["c1", "c-urgent"], b: ["c3"] });
    const boom = () => {
      throw new Error("rank must not be called when fully manual");
    };
    expect(() => orderLanes(repos, conversations, boom, { order, autoConvs: false, autoRepos: false })).not.toThrow();
  });
});
