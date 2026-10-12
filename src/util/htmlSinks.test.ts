// Guard against NEW raw-HTML sinks in the app's own code (security review M7).
//
// The main webview runs with no CSP and can call every IPC command (filesystem writes,
// terminal, ssh bootstrap…), so a single in-origin HTML injection would be local code
// execution, not just a broken page. React escapes everything it renders; the only ways
// around that are the sinks below. Each one that exists today was reviewed and is listed in
// ALLOWED with the reason it is safe and HOW MANY times it may appear in its file — adding a
// new one (or a second one in an allowed file) fails this test until it is reviewed the
// same way and added here.
//
// Scope: every `.ts` / `.tsx` under `src/`, except test files — they only build jsdom
// fixtures (`document.body.innerHTML = …`) and never reach the bundle (this one included: it
// names the sinks it looks for).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The sinks: each pattern matches one USE (an assignment, not a read, for the properties). */
const SINKS: Record<string, RegExp> = {
  dangerouslySetInnerHTML: /\bdangerouslySetInnerHTML\b/g,
  // react-markdown's raw-HTML pass-through, and the option that feeds it.
  "rehype-raw": /\brehype-raw\b|\brehypeRaw\b/g,
  allowDangerousHtml: /\ballowDangerousHtml\b/g,
  "innerHTML assignment": /\.innerHTML\s*\+?=(?!=)/g,
  "outerHTML assignment": /\.outerHTML\s*\+?=(?!=)/g,
  insertAdjacentHTML: /\binsertAdjacentHTML\s*\(/g,
  "document.write": /\bdocument\.write(?:ln)?\s*\(/g,
  createContextualFragment: /\bcreateContextualFragment\s*\(/g,
};

/** Reviewed sites: `path` (from `src/`, `/`-separated) → sink → allowed count + why it is safe. */
const ALLOWED: Record<string, Record<string, { count: number; reason: string }>> = {
  "features/conversation/CodeBlock.tsx": {
    dangerouslySetInnerHTML: {
      count: 1,
      reason: "highlight.js output: hljs escapes the source text and only adds its own <span class> markup.",
    },
  },
  "features/settings/ControlSection.tsx": {
    dangerouslySetInnerHTML: {
      count: 1,
      reason: "pairing QR SVG built in Rust (relay::qr_svg) from integer module coordinates; no text reaches the markup.",
    },
  },
};

// Built with `path`, not `new URL(…, import.meta.url)` (Vite rewrites that form).
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every sink use in `src/`, as `{ file: { sink: count } }`. */
function scan(): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    const text = readFileSync(path, "utf8");
    for (const [sink, re] of Object.entries(SINKS)) {
      const n = text.match(re)?.length ?? 0;
      if (n > 0) (found[file] ??= {})[sink] = n;
    }
  }
  return found;
}

describe("raw-HTML sinks in src/ (M7)", () => {
  const found = scan();

  it("are all reviewed: no sink outside the allowlist, none beyond its allowed count", () => {
    const unreviewed: string[] = [];
    for (const [file, sinks] of Object.entries(found)) {
      for (const [sink, n] of Object.entries(sinks)) {
        const allowed = ALLOWED[file]?.[sink]?.count ?? 0;
        if (n > allowed) unreviewed.push(`${file}: ${n} × ${sink} (allowed: ${allowed})`);
      }
    }
    expect(unreviewed, "review the new sink, then list it in ALLOWED with its reason").toEqual([]);
  });

  it("lists no stale entry: every allowed site still exists, with a reason", () => {
    for (const [file, sinks] of Object.entries(ALLOWED)) {
      for (const [sink, { count, reason }] of Object.entries(sinks)) {
        expect(found[file]?.[sink] ?? 0, `${file}: ${sink} is gone — drop it from ALLOWED`).toBe(count);
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("actually detects each sink (the patterns are not dead)", () => {
    const samples: Record<string, string> = {
      dangerouslySetInnerHTML: "<div dangerouslySetInnerHTML={{ __html: x }} />",
      "rehype-raw": 'import rehypeRaw from "rehype-raw";',
      allowDangerousHtml: "remarkRehypeOptions={{ allowDangerousHtml: true }}",
      "innerHTML assignment": "el.innerHTML = html; el.innerHTML += more;",
      "outerHTML assignment": "el.outerHTML = html;",
      insertAdjacentHTML: 'el.insertAdjacentHTML("beforeend", html);',
      "document.write": "document.write(html);",
      createContextualFragment: "range.createContextualFragment(html);",
    };
    for (const [sink, re] of Object.entries(SINKS)) {
      expect(samples[sink].match(re)?.length ?? 0, sink).toBeGreaterThan(0);
    }
    // Reads and comparisons are not sinks.
    expect("const h = el.innerHTML; if (el.innerHTML === '') {}".match(SINKS["innerHTML assignment"])).toBeNull();
  });
});
