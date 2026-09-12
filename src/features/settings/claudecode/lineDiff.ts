// A line diff, so the instructions panel can show what saving would actually do.
//
// Tinting the whole box green when it is dirty says "something changed". It does not say
// WHAT — and the thing worth seeing before writing to a file you also edit by hand is the
// lines that would DISAPPEAR. Removals stay on screen, in red, until you save.
//
// Plain LCS over lines. The managed block is instructions, not a repository: a few dozen
// lines at most, so the O(n·m) table is free and a smarter algorithm would only cost
// readability.

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Line-by-line diff from `before` to `after`.
 *
 * Trailing newlines are normalised away so that adding one does not show up as a change —
 * it is not one the reader cares about, and it would put a spurious entry at the bottom of
 * every diff.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // Removals before additions on the same hunk: it reads as "this went, that came".
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** Whether a diff contains anything worth showing. */
export function hasChanges(diff: DiffLine[]): boolean {
  return diff.some((l) => l.kind !== "same");
}

/** How many lines each side would gain and lose — the one-line summary above the diff. */
export function countChanges(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Collapse long stretches of unchanged lines to a few lines of context either side, the
 * way a diff viewer does. A managed block that grows to a hundred lines should not bury
 * one changed line in ninety-nine identical ones.
 *
 * Returns the same list with elided runs replaced by a single `null` marker.
 */
export function withElisions(diff: DiffLine[], context = 2): Array<DiffLine | null> {
  const keep = new Set<number>();
  diff.forEach((line, i) => {
    if (line.kind === "same") return;
    for (let k = i - context; k <= i + context; k++) if (k >= 0 && k < diff.length) keep.add(k);
  });
  const out: Array<DiffLine | null> = [];
  let elided = false;
  diff.forEach((line, i) => {
    if (keep.has(i)) {
      out.push(line);
      elided = false;
    } else if (!elided) {
      out.push(null);
      elided = true;
    }
  });
  return out;
}

function splitLines(text: string): string[] {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}
