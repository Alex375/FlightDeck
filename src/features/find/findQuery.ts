// The query half of the in-app find (⌘F): turning what the user typed — plus the three
// VS Code toggles (match case, whole word, regex) — into a RegExp, and running it over a
// flat text. PURE (no DOM), so every rule here is unit-tested; the DOM half that builds
// that flat text out of a panel and maps hits back onto it lives in `textIndex.ts`.
//
// The global search (⌘⇧F) compiles the SAME options on the Rust side (`search/mod.rs`,
// the `regex` crate). The two engines agree on the literal / case / whole-word rules
// below; a regex is passed through to each engine's own dialect.

/** The three toggles of a find bar, shared by every surface (and by the global search). */
export interface FindOptions {
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { isRegex: false, matchCase: false, wholeWord: false };

/** A compiled query: the RegExp (global), or why the pattern is not one. `null` = nothing to
 *  search for (empty input) — not an error. */
export type CompiledQuery = { re: RegExp } | { error: string } | null;

/** One hit in a flat text: `[start, end)` in UTF-16 code units (JS string indices). */
export interface TextMatch {
  start: number;
  end: number;
}

/** Past this many hits a search stops counting: highlighting tens of thousands of ranges
 *  would freeze the webview for a query like "e", and nobody steps through them one by one.
 *  The bar says "10000+". */
export const MAX_MATCHES = 10_000;

/** Escape a literal for use inside a RegExp — the syntax characters only, so the result is
 *  valid with AND without the `u` flag (which rejects identity escapes such as `\-`). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A "word" character for the whole-word rule: any letter or digit in any script, or `_`.
 *  Unicode-aware on purpose — `\b` is ASCII-only in JS, so "été" would never be a whole word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Compile a find query. Rules (mirrored by the Rust global search):
 *  - literal mode escapes the pattern; regex mode passes it through;
 *  - case-insensitive unless `matchCase`;
 *  - whole word: regex mode is fenced on both sides; literal mode only on an edge whose
 *    character IS a word character, so "foo(" still matches as a whole word in "foo(x)"
 *    (a fence after "(" could never be satisfied);
 *  - `m`: `^`/`$` are line anchors.
 * A pattern the engine rejects returns `{ error }` with the engine's message — shown in the
 * bar, never swallowed.
 */
export function compileFindQuery(pattern: string, opts: FindOptions): CompiledQuery {
  if (pattern === "") return null;
  let source = opts.isRegex ? pattern : escapeRegExp(pattern);
  const flags = "gm" + (opts.matchCase ? "" : "i");
  if (opts.wholeWord) {
    const fenceStart = opts.isRegex || WORD_CHAR.test(pattern[0]);
    const fenceEnd = opts.isRegex || WORD_CHAR.test(pattern[pattern.length - 1]);
    const head = fenceStart ? "(?<![\\p{L}\\p{N}_])" : "";
    const tail = fenceEnd ? "(?![\\p{L}\\p{N}_])" : "";
    source = `${head}(?:${source})${tail}`;
  }
  // `u` first: it is what makes `\p{…}` (the whole-word fence) and astral characters work.
  // A user regex written for the legacy dialect (`\-`, `\_`…) is rejected under `u`; retry
  // without it rather than refuse a pattern the user reasonably expects to work. The fence
  // then degrades to `\b`, which is the best the legacy dialect has.
  try {
    return { re: new RegExp(source, flags + "u") };
  } catch (first) {
    if (!opts.isRegex) return { error: errorText(first) };
    try {
      const legacy = opts.wholeWord ? `\\b(?:${pattern})\\b` : pattern;
      return { re: new RegExp(legacy, flags) };
    } catch {
      // Report the `u`-mode message: it is the dialect we try first, and the two messages
      // are about the same mistake.
      return { error: errorText(first) };
    }
  }
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Engines prefix the whole source ("Invalid regular expression: /…/gmiu: …"); the user
  // knows what they typed — keep the reason.
  const reason = msg.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "");
  return `Invalid regular expression: ${reason}`;
}

/**
 * Every non-empty hit of `re` in `text`, in order, at most `cap` of them. Zero-length matches
 * (`a*`, `^`, a lookahead alone) are skipped — there is nothing to highlight — and never stall
 * the scan. `capped` says the scan stopped early.
 */
export function findAll(
  text: string,
  re: RegExp,
  cap: number = MAX_MATCHES,
): { matches: TextMatch[]; capped: boolean } {
  const matches: TextMatch[] = [];
  const g = re.global ? re : new RegExp(re.source, re.flags + "g");
  g.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      // Step past the empty match — by a whole code point under `u`, or we would split a
      // surrogate pair and the engine would report the same position forever.
      g.lastIndex = start + (g.unicode && isHighSurrogate(text.charCodeAt(start)) ? 2 : 1);
      if (g.lastIndex > text.length) break;
      continue;
    }
    matches.push({ start, end });
    if (matches.length >= cap) return { matches, capped: true };
  }
  return { matches, capped: false };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Which hit to land on when a search (re)starts: the first one at or after `anchor` (an offset
 * into the text — where the user is reading), else the LAST one before it. In a conversation
 * the user is usually at the bottom; landing on the nearest earlier hit (the most recent
 * mention) beats wrapping around to the very first message. -1 when there are no hits.
 */
export function initialMatchIndex(matches: readonly TextMatch[], anchor: number): number {
  if (matches.length === 0) return -1;
  for (let i = 0; i < matches.length; i++) if (matches[i].start >= anchor) return i;
  return matches.length - 1;
}

/** Step `current` by `delta` (±1) through `count` hits, wrapping at both ends. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

/** The text around ONE hit somewhere else (a global-search result) — used to land on that very
 *  occurrence once the panel shows it, rather than on whichever one happens to be nearest. */
export interface FindHint {
  before: string;
  after: string;
}

/** Letters and digits only, lowercased: a transcript holds raw markdown ("**foo** `bar`")
 *  while the panel shows it rendered ("foo bar") — comparing only the words survives that. */
function wordsOnly(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * The hit whose surroundings best match `hint` (words before it ending like the hint's, words
 * after it starting like the hint's), or -1 when none shares any context — the caller then
 * falls back to the hit nearest to the viewport.
 */
export function pickByHint(text: string, matches: readonly TextMatch[], hint: FindHint): number {
  const hb = wordsOnly(hint.before);
  const ha = wordsOnly(hint.after);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const before = wordsOnly(text.slice(Math.max(0, m.start - 120), m.start));
    const after = wordsOnly(text.slice(m.end, m.end + 120));
    const score = commonSuffix(before, hb) + commonPrefix(after, ha);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** "3 of 17", "No results", "1 of 10000+" — the bar's counter. */
export function countLabel(index: number, count: number, capped: boolean): string {
  if (count === 0) return "No results";
  const total = capped ? `${count}+` : String(count);
  return index >= 0 ? `${index + 1} of ${total}` : `${total} results`;
}

/** A selection worth seeding the find input with: one line, not blank, not huge. */
export function seedFromSelection(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t || t.length > 200 || /[\r\n]/.test(t)) return null;
  return t;
}
