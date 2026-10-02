import { useEffect, useRef } from "react";
import { commands } from "../../ipc/client";
import { useConversations } from "../../store/conversationsStore";
import { useDisplay } from "../../store/display";
import {
  isSuggestionsOptedIn,
  pauseChanges,
  usePromptSuggestions,
} from "../../store/promptSuggestions";

/**
 * Pauses prompt suggestions for every live conversation whose composer is NOT on screen,
 * and for all of them while the feature is off — mounted once globally (render-null).
 *
 * Each suggestion is a model call on the user's plan, and one nobody can see is wasted:
 * the binary exposes `set_prompt_suggestions_paused` for exactly this kind of host. The
 * pause lives in the process, so a respawn starts unpaused — the host tracks what it told
 * each HANDLE, and a new handle is a new process that has been told nothing yet.
 *
 * ⚠️ Best effort: verified live (2.1.286) that a build whose server-side gate is off acks
 * the pause and keeps generating. A suggestion that still arrives for a hidden
 * conversation is kept and shows when it is opened; nothing here can make that worse.
 */
export function PromptSuggestionPauseHost() {
  const convs = useConversations();
  const onScreen = usePromptSuggestions((s) => s.onScreen);
  const enabled = useDisplay((s) => s.promptSuggestions);
  // handle → the paused state last sent to it.
  const lastSent = useRef(new Map<string, boolean>());

  useEffect(() => {
    const live = convs.flatMap((c) =>
      c.handle && c.kind !== "codex" && isSuggestionsOptedIn(c.handle)
        ? [{ convId: c.id, handle: c.handle }]
        : [],
    );
    const liveHandles = new Set(live.map((l) => l.handle));
    for (const h of lastSent.current.keys()) if (!liveHandles.has(h)) lastSent.current.delete(h);
    for (const { handle, paused } of pauseChanges(live, onScreen, enabled, lastSent.current)) {
      // Recorded before the answer, and kept on a refusal: an older CLI without the subtype
      // would refuse every retry too, and the cost of not pausing is only the status quo.
      lastSent.current.set(handle, paused);
      void commands
        .setPromptSuggestionsPaused(handle, paused)
        .then((r) => {
          if (r.status !== "ok") console.warn("[prompt-suggestions] pause not applied:", r.error);
        })
        .catch((e) => console.warn("[prompt-suggestions] pause not applied:", e));
    }
  }, [convs, onScreen, enabled]);

  return null;
}
