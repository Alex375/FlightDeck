// TanStack Query wrapper around the `get_output_style` / `set_output_style` IPC.
//
// Output style is a USER-GLOBAL Claude setting (settings.json `outputStyle`), so unlike
// the per-conversation model/effort/permission chips it is cached under ONE key and shared
// by every surface that shows it (the composer chip on every conversation + the Settings
// selector). One write updates them all.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { Result } from "./client";

/** Throw on the Result.error branch so the query/mutation error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

const OUTPUT_STYLE_KEY = ["outputStyle"] as const;

/** The user's persisted global output style. `data` is the settings.json value, or
 *  `"default"` when the key is absent (the backend resolves that); `undefined` while the
 *  first read is in flight. A broken settings.json surfaces as the query's error, not a
 *  silent default. */
export function useOutputStyle() {
  return useQuery({
    queryKey: OUTPUT_STYLE_KEY,
    queryFn: () => unwrap(commands.getOutputStyle()),
    // The value changes rarely and only through us; a little staleness avoids refetching
    // on every re-render of a composer that mounts this on each conversation.
    staleTime: 5_000,
  });
}

/**
 * Set the global output style. Optimistic: the pick shows at once, and rolls back if the
 * write fails — the write CAN fail (a hand-broken settings.json, a read-only home), and a
 * chip that lied about it would be a silent error. `onSettled` re-reads so the cache holds
 * exactly what landed on disk (e.g. `"default"` when the key was removed).
 */
export function useSetOutputStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (style: string): Promise<null> => unwrap(commands.setOutputStyle(style)),
    onMutate: async (style) => {
      await qc.cancelQueries({ queryKey: OUTPUT_STYLE_KEY });
      const prev = qc.getQueryData<string>(OUTPUT_STYLE_KEY);
      qc.setQueryData<string>(OUTPUT_STYLE_KEY, style);
      return { prev };
    },
    onError: (_e, _style, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(OUTPUT_STYLE_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: OUTPUT_STYLE_KEY }),
  });
}
