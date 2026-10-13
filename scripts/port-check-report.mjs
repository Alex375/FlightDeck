// Port-check report — turns the raw `cargo check` / `cargo test` output of the Linux and
// Windows jobs (.github/workflows/port-check.yml) into the porting to-do list: errors
// grouped by module and file in the run's step summary, instead of a raw log to scroll.
//
// Usage (from the workflow):
//   cargo check --message-format=json 2>&1 | tee check.log | node scripts/port-check-report.mjs render
//     → the human-readable diagnostics for the job log (JSON in, rustc's own text out;
//       cargo's stderr lines pass through untouched)
//   node scripts/port-check-report.mjs summary --os <label> \
//       --check check.log --check-outcome <step outcome> \
//       --test test.log --test-outcome <step outcome>
//     → markdown on stdout, appended to $GITHUB_STEP_SUMMARY
//
// rustc stops by phase (name resolution before type checking) and cargo at the first crate
// that fails, so one run's list is never exhaustive: fixing it surfaces the next layer. It
// is a living to-do, not a census — the summary says so.
//
// Self-test: node --test scripts/port-check-report.test.mjs (part of `pnpm test:scripts`).

import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The app's own crate (src-tauri/Cargo.toml `[package] name`). Its warnings are counted;
// a dependency's are not (they are the dependency's business, and cargo caps them anyway).
export const OWN_CRATE = "tosse-code";

// Per-module cap on listed errors, so one module with hundreds of errors cannot push the
// summary past GitHub's 1 MiB step-summary limit. The count stays exact; only the list is cut.
const MAX_ERRORS_PER_MODULE = 60;
const MAX_FREQUENT = 12;
const MAX_STRAY_BLOCK_LINES = 40;
const TEST_TAIL_LINES = 40;
const MAX_PANIC_LINES = 8;

/** Crate name from a cargo `package_id` — both the current spec form
 *  (`registry+https://…#libc@0.2.150`, `path+file:///…/src-tauri#tosse-code@2.12.0`,
 *  `path+file:///…/foo#0.1.0` when the name equals the directory) and the legacy
 *  `name version (source)` form. */
export function packageName(id) {
  if (!id) return null;
  const hash = id.lastIndexOf("#");
  if (hash === -1) return id.split(" ")[0] || null;
  const fragment = id.slice(hash + 1);
  const at = fragment.indexOf("@");
  if (at !== -1) return fragment.slice(0, at);
  return id.slice(0, hash).replace(/\/+$/, "").split("/").pop() || null;
}

const toSlash = (p) => p.replaceAll("\\", "/");

// rustc's closing lines ("aborting due to 87 previous errors") are `error`-level messages
// with no span: they would show up as one more error with no location.
const isClosingNoise = (message) => /^aborting due to\b/.test(message);

/** Parses a `cargo check --message-format=json 2>&1` log: JSON lines are rustc diagnostics,
 *  the rest is cargo's stderr (where a failing build script or a missing system library
 *  shows up — never as a JSON diagnostic). */
export function parseCheckLog(text, ownCrate = OWN_CRATE) {
  const errors = [];
  const seenErrors = new Set();
  const seenWarnings = new Set();
  let warnings = 0;
  const strayBlocks = [];
  let stray = null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    let msg = null;
    if (line.startsWith("{")) {
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
    }
    if (msg) {
      stray = null;
      if (msg.reason !== "compiler-message" || !msg.message) continue;
      const m = msg.message;
      const crate = packageName(msg.package_id);
      const span = (m.spans ?? []).find((s) => s.is_primary) ?? m.spans?.[0] ?? null;
      const file = span ? toSlash(span.file_name) : null;
      const message = String(m.message ?? "").split("\n")[0];
      // `--lib --tests` compiles the library twice (plain + test harness): same diagnostic,
      // reported twice. One entry per (crate, location, code, message).
      const key = [crate, file, span?.line_start, span?.column_start, m.code?.code, message].join("\u0000");
      if (m.level === "warning") {
        if (crate === ownCrate && !seenWarnings.has(key)) {
          seenWarnings.add(key);
          warnings++;
        }
        continue;
      }
      if (!String(m.level).startsWith("error") || isClosingNoise(message)) continue;
      if (seenErrors.has(key)) continue;
      seenErrors.add(key);
      errors.push({ crate, file, line: span?.line_start ?? null, code: m.code?.code ?? null, message });
      continue;
    }

    // cargo's stderr. "could not compile `<own crate>`" only repeats the count above; any
    // other `error` line (a dependency or a build script that failed) is kept with what
    // follows it, which is where cargo prints the build script's own output.
    if (/^error(\[|:)/.test(line)) {
      const ownRecap = line.startsWith("error: could not compile `") && line.includes(`\`${ownCrate}\``);
      if (ownRecap) {
        stray = null;
        continue;
      }
      stray = [line];
      strayBlocks.push(stray);
      continue;
    }
    if (/^warning(\[|:)/.test(line)) {
      stray = null;
      continue;
    }
    if (stray && stray.length < MAX_STRAY_BLOCK_LINES) stray.push(line);
  }
  return { errors, warnings, strayBlocks: strayBlocks.map((b) => trimTrailingBlank(b)) };
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** The porting unit an error belongs to: the top-level module of the app crate
 *  (`src/supervisor/codex/transport.rs` → `supervisor`, `src/lib.rs` → `lib`), or the
 *  dependency that failed. */
export function moduleOf(err, ownCrate = OWN_CRATE) {
  if (err.crate && err.crate !== ownCrate) return `dependency: ${err.crate}`;
  if (!err.file) return "(no location)";
  if (!err.file.startsWith("src/")) return err.file;
  const parts = err.file.slice("src/".length).split("/");
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.rs$/, "");
}

/** Parses `cargo test` output: the failed tests (with their panic excerpt), and the
 *  `test result:` line — whose absence means the test binary never finished (link error,
 *  crash, or a step timeout). */
export function parseTestLog(text) {
  const lines = text.split(/\r?\n/);
  const failed = [];
  const failedSet = new Set();
  const panics = new Map();
  let result = null;
  let current = null;

  for (const line of lines) {
    let m;
    if ((m = /^test (\S+) \.\.\. FAILED$/.exec(line))) {
      if (!failedSet.has(m[1])) {
        failedSet.add(m[1]);
        failed.push(m[1]);
      }
      continue;
    }
    if ((m = /^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line))) {
      result = { ok: m[1] === "ok", passed: +m[2], failed: +m[3], ignored: +m[4] };
      current = null;
      continue;
    }
    if ((m = /^---- (\S+) stdout ----$/.exec(line))) {
      current = m[1];
      panics.set(current, []);
      continue;
    }
    if (line === "failures:") {
      current = null;
      continue;
    }
    if (current) {
      const block = panics.get(current);
      if (line.trim() === "" || line.startsWith("note: run with `RUST_BACKTRACE")) continue;
      if (block.length < MAX_PANIC_LINES) block.push(line);
    }
  }
  const tail = trimTrailingBlank(lines).slice(-TEST_TAIL_LINES);
  return { failed: failed.map((name) => ({ name, panic: panics.get(name) ?? [] })), result, tail };
}

// --- markdown -------------------------------------------------------------------------

/** One line of compiler text made safe for GitHub markdown: `<…>` outside code spans would
 *  be eaten as HTML (`Vec<u8>` → `Vec`), and `|` ends a table cell even inside a code span. */
export function inlineMd(text, { table = false } = {}) {
  const segments = String(text).split("`");
  return segments
    .map((seg, i) => {
      let s = i % 2 === 1 ? seg : seg.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      if (table) s = s.replaceAll("|", "\\|");
      return s;
    })
    .join("`");
}

function fence(lines) {
  // A fence longer than any backtick run inside, so compiler output cannot close it early.
  const longest = Math.max(2, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));
  const f = "`".repeat(longest + 1);
  return [`${f}text`, ...lines, f].join("\n");
}

const indent = (text, pad) =>
  text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const NOT_RUN = new Set(["", "skipped", undefined, null]);

function checkRow(outcome, check) {
  if (NOT_RUN.has(outcome)) return "⏭️ not run (an earlier step failed)";
  if (outcome === "cancelled") return "⚠️ cancelled";
  if (!check) return outcome === "success" ? "✅ compiles" : "❌ failed — no log captured";
  const warn = check.warnings ? ` · ${plural(check.warnings, "warning")}` : "";
  if (outcome === "success") return `✅ compiles${warn}`;
  const files = new Set(check.errors.map((e) => e.file ?? "(no location)")).size;
  if (check.errors.length) return `❌ ${plural(check.errors.length, "error")} in ${plural(files, "file")}${warn}`;
  return `❌ failed outside rustc diagnostics (see below)${warn}`;
}

function testRow(outcome, checkOutcome, test) {
  if (NOT_RUN.has(outcome)) {
    return checkOutcome === "failure" ? "⏭️ not run (does not compile yet)" : "⏭️ not run (an earlier step failed)";
  }
  if (outcome === "cancelled") return "⚠️ cancelled (step timeout?) — see the log tail below";
  const r = test?.result;
  if (outcome === "success") return r ? `✅ ${r.passed} passed, ${r.ignored} ignored` : "✅ passed";
  if (r) return `❌ ${plural(r.failed, "failed test")} · ${r.passed} passed`;
  return "❌ did not finish (link error, crash or timeout) — see the log tail below";
}

/** The step-summary markdown for one OS job. `check`/`test` are the parsed logs (null when
 *  the step never wrote one); outcomes are the workflow's `steps.<id>.outcome`. */
export function renderSummary({ os, checkOutcome, check, testOutcome, test }) {
  const out = [];
  out.push(`## ${os}`, "");
  out.push("| Step | Result |", "|---|---|");
  out.push(`| \`cargo check --lib --tests\` | ${checkRow(checkOutcome, check)} |`);
  out.push(`| \`cargo test --lib\` | ${testRow(testOutcome, checkOutcome, test)} |`);
  out.push("");

  const errors = check?.errors ?? [];
  if (errors.length) {
    out.push(
      "> rustc stops by phase and cargo at the first crate that fails: fixing these surfaces the next layer. " +
        "Paths are relative to `src-tauri/`.",
      "",
    );

    const frequent = [...groupBy(errors, (e) => `${e.code ?? ""}\u0000${e.message}`).values()]
      .filter((g) => g.length > 1)
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_FREQUENT);
    if (frequent.length) {
      out.push("### Most frequent errors", "", "| × | Error |", "|---:|---|");
      for (const g of frequent) {
        const e = g[0];
        out.push(`| ${g.length} | ${e.code ? `\`${e.code}\` ` : ""}${inlineMd(e.message, { table: true })} |`);
      }
      out.push("");
    }

    const byModule = [...groupBy(errors, (e) => moduleOf(e)).entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    out.push("### Errors by module", "", "| Module | Errors | Files |", "|---|---:|---:|");
    for (const [mod, errs] of byModule) {
      const files = new Set(errs.map((e) => e.file)).size;
      out.push(`| ${inlineMd(mod, { table: true })} | ${errs.length} | ${files} |`);
    }
    out.push("");

    for (const [mod, errs] of byModule) {
      const files = [...groupBy(errs, (e) => e.file ?? "(no location)").entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      out.push(
        `<details><summary><b>${inlineMd(mod)}</b> — ${plural(errs.length, "error")} in ${plural(files.length, "file")}</summary>`,
        "",
      );
      let listed = 0;
      for (const [file, fileErrs] of files) {
        if (listed >= MAX_ERRORS_PER_MODULE) break;
        out.push(`**\`${file}\`** (${fileErrs.length})`, "");
        for (const e of [...fileErrs].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
          if (listed >= MAX_ERRORS_PER_MODULE) break;
          const where = e.line != null ? `L${e.line} ` : "";
          out.push(`- ${where}${e.code ? `\`${e.code}\` ` : ""}${inlineMd(e.message)}`);
          listed++;
        }
        out.push("");
      }
      if (errs.length > listed) out.push(`_… ${errs.length - listed} more in this module — see the job log._`, "");
      out.push("</details>", "");
    }
  }

  if (check?.strayBlocks?.length) {
    out.push("### Build errors outside rustc diagnostics", "");
    for (const block of check.strayBlocks) out.push(fence(block), "");
  }

  if (test?.failed?.length) {
    out.push("### Failing tests by module", "");
    const byModule = [...groupBy(test.failed, (t) => t.name.split("::")[0]).entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    for (const [mod, tests] of byModule) {
      out.push(`<details><summary><b>${inlineMd(mod)}</b> — ${plural(tests.length, "test")}</summary>`, "");
      for (const t of tests) {
        out.push(`- \`${t.name}\``);
        // Indented so the block stays inside its list item.
        if (t.panic.length) out.push("", indent(fence(t.panic), "  "), "");
      }
      out.push("", "</details>", "");
    }
  } else if (test && testOutcome && !NOT_RUN.has(testOutcome) && testOutcome !== "success" && !test.result) {
    out.push("### Test log tail", "", fence(test.tail), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// --- CLI ------------------------------------------------------------------------------

function readIfPresent(file) {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${a}`);
    args[a.slice(2)] = value;
    i++;
  }
  return args;
}

async function render() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // `--lib --tests` reports every diagnostic twice (plain + test harness): print each once.
  const printed = new Set();
  for await (const line of rl) {
    if (line.startsWith("{")) {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (msg) {
        const rendered = msg.reason === "compiler-message" ? msg.message?.rendered : null;
        if (rendered && !printed.has(rendered)) {
          printed.add(rendered);
          process.stdout.write(rendered);
        }
        continue;
      }
    }
    process.stdout.write(line + "\n");
  }
}

function summary(argv) {
  const args = parseArgs(argv);
  if (!args.os) throw new Error("--os is required");
  const checkText = readIfPresent(args.check);
  const testText = readIfPresent(args.test);
  process.stdout.write(
    renderSummary({
      os: args.os,
      checkOutcome: args["check-outcome"] ?? "",
      check: checkText == null ? null : parseCheckLog(checkText),
      testOutcome: args["test-outcome"] ?? "",
      test: testText == null ? null : parseTestLog(testText),
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "render") await render();
  else if (mode === "summary") summary(rest);
  else {
    process.stderr.write("usage: port-check-report.mjs render | summary --os <label> [--check f] [--test f] …\n");
    process.exit(2);
  }
}
