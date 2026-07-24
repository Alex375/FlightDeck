import { useEffect, useRef } from "react";
import { commands, events } from "../../ipc/client";
import { useEditorStore } from "./editorStore";
import { useAppErrors } from "../../store/appErrors";

/** How often open tabs are re-checked against the disk when no fs event can tell
 *  us (see the safety-net effect). Short enough that a rewritten PDF looks live,
 *  long enough that the cost — one batched `stat` over the open tabs — is noise. */
const DISK_POLL_MS = 2000;

/** Run a watch IPC call, logging both an error Result and a thrown rejection.
 *  Watch is best-effort (a failure only means live-refresh won't fire) but must
 *  never fail silently — a dead watch is otherwise invisible. */
function runWatch(
  label: string,
  run: () => Promise<{ status: "ok"; data: null } | { status: "error"; error: string }>,
): void {
  run()
    .then((r) => {
      if (r.status !== "ok") console.error(`[fsWatch] ${label} failed:`, r.error);
    })
    .catch((e) => console.error(`[fsWatch] ${label} threw:`, e));
}

/**
 * Keep the core's single filesystem watch pointed at the editor's current working
 * directory, and route its coalesced `FsChangeEvent`s into the editor store
 * (reload open files per the conflict policy, refresh expanded tree dirs).
 *
 * The watch follows `cwd`: switching conversation — or the agent entering a
 * worktree (a live cwd move) — re-points it. When the panel closes (`enabled`
 * false) the watch is dropped.
 *
 * Events are the FAST path, not the only one: this hook also resyncs open tabs
 * whenever the watch (re)points, and on a timer, so a write the watcher can't
 * report (ignored dir, outside the cwd, another conversation, dead watcher) still
 * reaches the open tab. Both go through `resyncOpenBuffers`, which stats before it
 * reads — an unchanged tab costs a syscall.
 */
export function useFsWatch(convId: string, cwd: string | null, enabled: boolean): void {
  // Always-current target for the (once-registered) event listener.
  const ctx = useRef({ convId, cwd });
  ctx.current = { convId, cwd };

  // (Re)point the OS watch while the panel is open.
  useEffect(() => {
    if (!enabled || !cwd) {
      runWatch("unwatchDir", () => commands.unwatchDir());
      return;
    }
    runWatch("watchDir", () => commands.watchDir(cwd));
    return () => {
      runWatch("unwatchDir", () => commands.unwatchDir());
    };
  }, [enabled, cwd]);

  // Catch up on changes missed while this cwd was NOT the watched one. There is a
  // single OS watch shared across conversations: switching conversation — or the
  // agent moving cwd (worktree) — re-points it, and it only reports changes from
  // the moment it (re)starts. So anything the agent wrote to an open file while we
  // were on another conversation (or the editor was closed) produced no event; its
  // buffer would stay stale until manually reopened. Re-reading here on every
  // (re)point closes that gap. Declared AFTER the watch effect so `watchDir` is
  // issued first — a change landing in the gap then also fires a normal event.
  useEffect(() => {
    if (!enabled || !cwd) return;
    void useEditorStore.getState().resyncOpenBuffers(convId);
  }, [enabled, cwd, convId]);

  // Safety net: some writes reach an open tab through NO event at all, so no amount
  // of watch plumbing would catch them —
  //   - the file lives under an ignored dir (build/, dist/, target/… — the watcher
  //     drops those wholesale so a busy node_modules can't flood the UI, but a PDF
  //     compiled into build/ is exactly the file you have open),
  //   - the file sits outside the watched cwd (opened through a file mention),
  //   - the watcher backend died (an error banner is shown, but the tabs would then
  //     never refresh again for the rest of the session).
  // A periodic resync closes all three at once. It is deliberately built on the same
  // stamp check as everything else: one batched `stat` per tick, and a real read only
  // for what actually moved — so an idle panel costs a handful of syscalls a minute.
  // Paused while the window is hidden: nobody is looking, and the (re)point resync
  // plus the next tick catch up on return.
  useEffect(() => {
    if (!enabled || !cwd) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void useEditorStore.getState().resyncOpenBuffers(convId);
    };
    const id = setInterval(tick, DISK_POLL_MS);
    // Coming back to a hidden-then-visible window shouldn't wait out a whole period.
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, cwd, convId]);

  // Subscribe once; the handler reads the live target from the ref. A failed
  // listen() registration is logged rather than swallowed.
  useEffect(() => {
    let disposed = false;
    const uns: Array<() => void> = [];
    const track = (p: Promise<() => void>, label: string) =>
      p
        .then((fn) => {
          if (disposed) fn();
          else uns.push(fn);
        })
        .catch((e) => console.error(`[fsWatch] ${label}.listen failed:`, e));

    track(
      events.fsChangeEvent.listen((e) => {
        if (disposed) return;
        const { convId, cwd } = ctx.current;
        if (!cwd) return;
        void useEditorStore.getState().onExternalChange(convId, e.payload.paths);
      }),
      "fsChangeEvent",
    );

    // The watcher backend died: live refresh has stopped, so the tree/open files can
    // go stale without any sign. Surface it (deduped) instead of letting it be silent.
    track(
      events.fsWatchErrorEvent.listen((e) => {
        if (disposed) return;
        console.error("[fsWatch] watcher backend error:", e.payload.message);
        useAppErrors
          .getState()
          .pushError(
            "File watching stopped — the tree and open files may not refresh automatically.",
            e.payload.message,
          );
      }),
      "fsWatchErrorEvent",
    );

    return () => {
      disposed = true;
      uns.forEach((un) => un());
    };
  }, []);
}
