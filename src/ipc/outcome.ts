// A command's answer as data or words — for a caller that must SHOW a failure rather than
// throw it: a rejected invoke becomes an `error` like any other, so nothing waiting on it
// is ever left spinning.

/** The data, or why there is none. */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Run one command and keep its failure as words — a rejected invoke included. */
export async function outcome<T>(
  run: () => Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<Outcome<T>> {
  try {
    const res = await run();
    return res.status === "ok" ? { ok: true, data: res.data } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
