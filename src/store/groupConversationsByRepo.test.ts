import { describe, it, expect } from "vitest";
import { groupConversationsByRepoOrdered } from "./conversationsStore";
import type { Conversation, Repo } from "./conversationsStore";
import type { OrderBlob } from "./manualOrder";

function repo(id: string, addedAt: number): Repo {
  return { id, path: "/r/" + id, addedAt };
}
function conv(id: string, repoId: string, lastActivityAt: number): Conversation {
  return { id, repoId, lastActivityAt } as unknown as Conversation;
}

/** No drag has ever happened. With both `auto*` flags on it is not read at all. */
const NO_MANUAL_ORDER: OrderBlob = { repoOrder: [], convOrder: {} };

/**
 * The RECENCY ordering, which is `groupConversationsByRepoOrdered` with both automatic-order
 * flags on — the sidebar's default and what ⌘⌥↑/↓ walks. Asserted through the function the
 * app actually renders: the recency-only helper these tests used to call had no production
 * caller left, so a change to this comparator could pass here while nothing on screen moved.
 */
describe("groupConversationsByRepoOrdered (automatic = recency)", () => {
  const byRecency = (repos: Repo[], conversations: Conversation[]) =>
    groupConversationsByRepoOrdered(repos, conversations, NO_MANUAL_ORDER, true, true);

  it("groups by repo, sorts convs by recency desc, orders repos by most recent conv", () => {
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [conv("c1", "a", 100), conv("c2", "a", 300), conv("c3", "b", 200)];

    const groups = byRecency(repos, conversations);

    // Repo "a" has a conversation at 300, beating "b"'s most recent at 200.
    expect(groups.map((g) => g.repo.id)).toEqual(["a", "b"]);
    // Within a repo, the most recently active conversation comes first.
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("an empty repo orders by its addedAt and yields an empty conversation list", () => {
    const repos = [repo("a", 1), repo("empty", 999)];

    const groups = byRecency(repos, [conv("c1", "a", 50)]);

    // The empty repo's addedAt (999) outranks repo "a"'s most-recent conv (50).
    expect(groups.map((g) => g.repo.id)).toEqual(["empty", "a"]);
    expect(groups.find((g) => g.repo.id === "empty")!.conversations).toEqual([]);
  });

  it("orders two conversation-less repos by addedAt (most recent first)", () => {
    // Both empty → the addedAt fallback is the only tiebreak; exercises its direction.
    const groups = byRecency([repo("old", 100), repo("new", 200)], []);

    expect(groups.map((g) => g.repo.id)).toEqual(["new", "old"]);
    expect(groups.every((g) => g.conversations.length === 0)).toBe(true);
  });
});
