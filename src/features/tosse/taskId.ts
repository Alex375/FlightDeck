// The one gate every TOSSE task id passes through before it can become a URL.
//
// A task id reaches this app from two places that both deserve suspicion: an agent's tool
// input (which a prompt injection can dictate — a poisoned README, a web page, repository
// content) and the CRM's own payloads. Both end up concatenated onto a tasks path, in the
// app-control executor (`tosse_task_detail`, which carries the human's Bearer token) and in
// the thread card's browser fallback (`<origin>/tasks/<id>`, opened in the real browser).
//
// A path traversal there is not theoretical: `../admin/users/deactivate?id=42` normalises
// out of `/tasks/` entirely and lands on a different endpoint of the CRM, under the user's
// own session. So an id is either the canonical shape or it is nothing — never "probably
// fine". The SAME check exists in Rust; two independent gates on purpose, neither one
// load-bearing alone.
const TOSSE_TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical (lower-case) form of a task id, or `null` when it is not one.
 *
 * The regex is case-INSENSITIVE, so the same task can be named `A1B2…` or `a1b2…`;
 * normalizing here, once, at the single gate every id passes through, is what makes the
 * comparisons downstream mean anything. Compared raw, one spelling of a task reads as a
 * DIFFERENT task from the other: re-linking the task already linked would be refused as
 * "already linked to another task", and the guard that stops an unverified guess from
 * erasing a CRM-verified title/status would miss.
 */
export function canonicalTosseTaskId(raw: string | null | undefined): string | null {
  return raw && TOSSE_TASK_ID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** Do these two ids name the same task? A stored id came either from the CRM (whatever case
 *  it serializes in) or from an agent (normalized above), so identity is decided on the
 *  canonical form, never on the bytes. */
export function sameTaskId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
