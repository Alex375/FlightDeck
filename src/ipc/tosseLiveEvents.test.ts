import { describe, expect, it } from "vitest";
import {
  allTosseQueryKeys,
  connectionRefetch,
  crmEventQueryKeys,
  mergeInvalidationKeys,
  recycleRefetchKeys,
} from "./tosseLiveEvents";
import {
  tosseBacklogKey,
  tosseBriefingKey,
  tosseProjectReposKey,
  tosseRepoLinksKey,
  tosseTaskKeyPrefix,
} from "./useTosse";

/** Compare key lists as sets — the order they are invalidated in carries no meaning. */
const asSet = (keys: readonly (readonly unknown[])[]) =>
  new Set(keys.map((k) => JSON.stringify(k)));

describe("crmEventQueryKeys", () => {
  it("refreshes the board for every task change", () => {
    for (const kind of ["task:created", "task:updated", "task:archived"]) {
      expect(asSet(crmEventQueryKeys(kind))).toEqual(
        asSet([tosseBriefingKey, tosseBacklogKey, tosseTaskKeyPrefix]),
      );
    }
  });

  // A blocking link decides whether a task can be picked up, and the detail panel draws it.
  it("treats relation events as task changes", () => {
    for (const kind of [
      "task:relation_created",
      "task:relation_removed",
      "task:relations_resolved",
      "task:relations_reactivated",
    ]) {
      expect(crmEventQueryKeys(kind).length).toBeGreaterThan(0);
      expect(asSet(crmEventQueryKeys(kind))).toContain(JSON.stringify(tosseBriefingKey));
    }
  });

  // A project moving between active and paused takes its tasks with it, so the briefing —
  // not merely a project list — is what goes stale.
  it("refreshes the board and the folder pins for a project change", () => {
    expect(asSet(crmEventQueryKeys("project:archived"))).toEqual(
      asSet([tosseBriefingKey, tosseBacklogKey, tosseTaskKeyPrefix, tosseProjectReposKey]),
    );
  });

  it("refreshes the repository links for a repository change", () => {
    expect(asSet(crmEventQueryKeys("repository:updated"))).toEqual(asSet([tosseRepoLinksKey]));
  });

  it("refreshes the board for a mission change", () => {
    expect(asSet(crmEventQueryKeys("mission:updated"))).toEqual(asSet([tosseBriefingKey]));
  });

  // THE point of the mapping: the CRM broadcast is global and carries other domains
  // entirely. Invalidating on those would refetch the whole board on every financial cron
  // tick — the polling this feature exists to avoid, wearing a different hat.
  it("invalidates nothing for the domains this app does not read", () => {
    for (const kind of [
      "finance:created",
      "finance:updated",
      "qonto:synced",
      "cron:executed",
      "settings:updated",
      "appointment:created",
      "connected",
      "message",
      "",
    ]) {
      expect(crmEventQueryKeys(kind), kind).toEqual([]);
    }
  });
});

describe("mergeInvalidationKeys", () => {
  it("collapses a burst into one refetch per query", () => {
    const merged = mergeInvalidationKeys([
      "task:updated",
      "task:updated",
      "task:relation_created",
    ]);
    expect(merged).toHaveLength(3);
    expect(asSet(merged)).toEqual(
      asSet([tosseBriefingKey, tosseBacklogKey, tosseTaskKeyPrefix]),
    );
  });

  it("unions across domains and drops the noise", () => {
    const merged = mergeInvalidationKeys(["finance:created", "repository:created"]);
    expect(asSet(merged)).toEqual(asSet([tosseRepoLinksKey]));
  });

  it("is empty when nothing in the burst concerns us", () => {
    expect(mergeInvalidationKeys(["cron:executed", "qonto:synced"])).toEqual([]);
  });
});

describe("connectionRefetch", () => {
  const live = (connections: number) => ({ state: "live", connections });

  it("refetches on the first connection", () => {
    expect(connectionRefetch(live(1), 0)).toEqual({ refetch: true, nextHandled: 1 });
  });

  // The production case: the server ends an idle stream every ~12 s and the core reopens it
  // while staying on `live`. A transition test would see nothing; the counter catches it.
  it("refetches on a reconnection that never left the live state", () => {
    expect(connectionRefetch(live(2), 1)).toEqual({ refetch: true, nextHandled: 2 });
  });

  it("does not refetch when the same state is re-delivered", () => {
    expect(connectionRefetch(live(2), 2)).toEqual({ refetch: false, nextHandled: 2 });
  });

  it("does not refetch while merely connecting or failing", () => {
    expect(connectionRefetch({ state: "connecting", connections: 3 }, 3).refetch).toBe(false);
    expect(connectionRefetch({ state: "error", connections: 3 }, 3).refetch).toBe(false);
  });

  // Signing out and back in restarts the core's counter at 1. Without the reset, that 1
  // matches the 1 we remembered and the restart — the moment a refetch matters most — would
  // silently skip it.
  it("resets on stop so the next start refetches again", () => {
    const stopped = connectionRefetch({ state: "off", connections: 0 }, 1);
    expect(stopped).toEqual({ refetch: false, nextHandled: 0 });
    expect(connectionRefetch(live(1), stopped.nextHandled).refetch).toBe(true);
  });
});

describe("allTosseQueryKeys", () => {
  // The reconnection refetch has to be a superset of every mapped key: the server offers no
  // replay, so a key reachable through an event but missing here would stay stale exactly
  // when we know we may have missed its event.
  it("covers every key any single event can invalidate", () => {
    const all = asSet(allTosseQueryKeys());
    for (const kind of [
      "task:updated",
      "project:updated",
      "mission:updated",
      "repository:updated",
      "client:updated",
    ]) {
      for (const key of crmEventQueryKeys(kind)) {
        expect(all, `${kind} → ${JSON.stringify(key)}`).toContain(JSON.stringify(key));
      }
    }
  });
});

describe("recycleRefetchKeys", () => {
  // The server ends an idle stream every ~12 s, so this sweep is the one that repeats. It
  // must stay a SUBSET of the outage sweep — anything it drops is covered the moment the
  // channel actually goes down.
  it("is a subset of the full reconnection sweep", () => {
    const all = asSet(allTosseQueryKeys());
    for (const key of recycleRefetchKeys()) {
      expect(all).toContain(JSON.stringify(key));
    }
  });

  // ⚠️ The whole point: refetching the repo links costs an HTTPS round trip PLUS one
  // `git remote get-url` per Flight Deck folder, and the badge keeps that query mounted
  // app-wide. Paying it on a repeating timer is the polling this feature removed.
  it("leaves out the repo links, which a ~200 ms gap cannot plausibly have changed", () => {
    expect(asSet(recycleRefetchKeys())).not.toContain(JSON.stringify(tosseRepoLinksKey));
  });

  // The board itself is the thing a missed event would leave stale, so it must be there.
  it("still covers everything a task event invalidates", () => {
    const recycle = asSet(recycleRefetchKeys());
    for (const key of crmEventQueryKeys("task:updated")) {
      expect(recycle).toContain(JSON.stringify(key));
    }
  });
});
