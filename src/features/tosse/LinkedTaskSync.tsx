// Keeps every LINKED conversation's copy of its task honest, whatever view is open.
//
// The copy exists so the link stays legible offline (see `Conversation.tosseTaskTitle`), and
// the delete warning reads it before killing a conversation. Until now it was only ever
// re-stamped by the tasks view's briefing — so it went stale in two different ways:
//
//   1. the briefing never ran at all unless the TOSSE tab was opened this session;
//   2. even when it ran, it structurally omits a finished task, and an absent task is
//      deliberately left alone rather than erased — so « Fait » never arrived.
//
// Mounted once, globally, render-null (the `CaffeinateHost` pattern): the briefing runs on
// its own, and the handful of tasks it cannot carry are re-read one by one. Both refreshes
// happen inside their query functions, so nothing here has to push state around.

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useDisplay } from "../../store/display";
import { useConversationsStore } from "../../store/conversationsStore";
import { taskDetailQuery, useTosseBriefing, useTosseConnection } from "../../ipc/useTosse";
import { briefingTaskIds, tasksToReconcile, type LinkedTaskRef } from "./linkedTaskReconcile";

export function LinkedTaskSync() {
  // Same gate as the TOSSE tab itself: the preference off means the app makes NO CRM
  // requests at all, and the warning falls back to its last known values — which is exactly
  // what it is designed to do with no network.
  const tabEnabled = useDisplay((s) => s.tosseTasksView);
  const { data: connection } = useTosseConnection(tabEnabled);
  const connected = tabEnabled && connection?.connected === true;

  // The store's array identity is stable between updates, so this derivation only re-runs
  // when a conversation actually changes.
  const conversations = useConversationsStore((s) => s.conversations);
  const linked: LinkedTaskRef[] = useMemo(
    () =>
      conversations
        .filter((c) => c.tosseTaskId != null)
        .map((c) => ({ taskId: c.tosseTaskId as string, status: c.tosseTaskStatus })),
    [conversations],
  );

  // The bulk source. Shares its query key with the tasks view, so opening that view costs no
  // extra request — and closing it no longer stops the refresh. Its own query function
  // re-stamps every task it carries.
  const { data: briefing } = useTosseBriefing(connected && linked.length > 0);

  const pending = useMemo(
    () => tasksToReconcile(linked, briefingTaskIds(briefing)),
    [linked, briefing],
  );

  // One request per contradiction — a task we still believe is live that the board of live
  // tasks did not list. Self-limiting: the answer that says « Fait » takes the id out of the
  // set for good. Fire-and-forget on purpose; the re-stamp lives in the query function and a
  // failure keeps the last known value (the briefing above is what reports a dead session).
  useQueries({
    queries: pending.map((id) => ({ ...taskDetailQuery(id), enabled: connected })),
  });

  return null;
}
