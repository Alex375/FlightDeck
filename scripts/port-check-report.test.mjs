// Self-test for scripts/port-check-report.mjs — Node's own test runner (no vitest:
// vitest.config.ts is scoped to "src/**" front-end tests; this is a CI script).
// Fixtures mirror real cargo output (shapes captured from cargo 1.9x).
//
// Run: node --test scripts/port-check-report.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { inlineMd, moduleOf, packageName, parseCheckLog, parseTestLog, renderSummary } from "./port-check-report.mjs";

const OWN_ID = "path+file:///home/runner/work/FlightDeck/FlightDeck/src-tauri#tosse-code@2.12.0";

function diag({ id = OWN_ID, level = "error", code = null, message, file, line = 1, col = 1, target = "lib" }) {
  return JSON.stringify({
    reason: "compiler-message",
    package_id: id,
    target: { kind: [target] },
    message: {
      level,
      message,
      code: code ? { code, explanation: "…" } : null,
      spans: file ? [{ file_name: file, line_start: line, column_start: col, is_primary: true }] : [],
      rendered: `${level}: ${message}\n`,
    },
  });
}

test("packageName reads every package_id form cargo emits", () => {
  assert.equal(packageName(OWN_ID), "tosse-code");
  assert.equal(packageName("registry+https://github.com/rust-lang/crates.io-index#libc@0.2.150"), "libc");
  assert.equal(packageName("path+file:///work/flightdeckd#0.4.0"), "flightdeckd");
  assert.equal(packageName("libc 0.2.150 (registry+https://github.com/rust-lang/crates.io-index)"), "libc");
  assert.equal(packageName(undefined), null);
});

test("parseCheckLog keeps one entry per diagnostic although --lib --tests reports it twice", () => {
  const e = { code: "E0433", message: "cannot find module or crate `libc` in this scope", file: "src/power/mod.rs", line: 12 };
  const log = [
    "    Checking tosse-code v2.12.0 (/home/runner/work/FlightDeck/FlightDeck/src-tauri)",
    diag({ ...e, target: "lib" }),
    diag({ ...e, target: "test" }),
    diag({ message: "aborting due to 1 previous error" }),
    "error: could not compile `tosse-code` (lib) due to 1 previous error",
    "error: could not compile `tosse-code` (lib test) due to 1 previous error",
  ].join("\n");
  const parsed = parseCheckLog(log);
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(parsed.errors[0], { crate: "tosse-code", ...e });
  // The own-crate recap lines only repeat the count: not a stray build error.
  assert.deepEqual(parsed.strayBlocks, []);
});

test("parseCheckLog counts the app crate's warnings only, deduplicated", () => {
  const w = { level: "warning", message: "unused import: `std::os::unix`", file: "src/lib.rs", line: 3 };
  const log = [
    diag(w),
    diag({ ...w, target: "test" }),
    diag({ ...w, id: "registry+https://github.com/rust-lang/crates.io-index#gtk@0.18.1", file: "/x/gtk/src/a.rs" }),
  ].join("\n");
  const parsed = parseCheckLog(log);
  assert.equal(parsed.warnings, 1);
  assert.equal(parsed.errors.length, 0);
});

test("parseCheckLog normalises Windows paths", () => {
  const parsed = parseCheckLog(diag({ message: "boom", file: "src\\bootstrap\\mod.rs", line: 4 }));
  assert.equal(parsed.errors[0].file, "src/bootstrap/mod.rs");
});

test("parseCheckLog keeps a failing build script's stderr block — it never arrives as JSON", () => {
  const log = [
    "error: failed to run custom build command for `alsa-sys v0.3.1`",
    "",
    "Caused by:",
    "  process didn't exit successfully: `/target/debug/build/alsa-sys/build-script-build` (exit status: 101)",
    "  --- stderr",
    "  The system library `alsa` required by crate `alsa-sys` was not found.",
    "",
    "warning: build failed, waiting for other jobs to finish...",
    "error: could not compile `tosse-code` (lib) due to 1 previous error",
  ].join("\n");
  const parsed = parseCheckLog(log);
  assert.equal(parsed.strayBlocks.length, 1);
  assert.equal(parsed.strayBlocks[0][0], "error: failed to run custom build command for `alsa-sys v0.3.1`");
  assert.ok(parsed.strayBlocks[0].some((l) => l.includes("system library `alsa`")));
  // Stops at the next warning: cargo's own chatter is not part of the block.
  assert.ok(!parsed.strayBlocks[0].some((l) => l.startsWith("warning:")));
});

test("moduleOf groups by the app crate's top-level module, or by failing dependency", () => {
  const own = (file) => ({ crate: "tosse-code", file });
  assert.equal(moduleOf(own("src/supervisor/codex/transport.rs")), "supervisor");
  assert.equal(moduleOf(own("src/lib.rs")), "lib");
  assert.equal(moduleOf(own("build.rs")), "build.rs");
  assert.equal(moduleOf(own(null)), "(no location)");
  assert.equal(moduleOf({ crate: "alsa-sys", file: "/x/src/lib.rs" }), "dependency: alsa-sys");
});

const TEST_LOG = `     Running unittests src/lib.rs (target/debug/deps/tosse_code_lib-0cef1c17265a0b0d)

running 4 tests
test tests::live ... ignored
test tests::ok ... ok
test power::tests::caffeinate_holds ... FAILED
test tests::breaks ... FAILED

failures:

---- power::tests::caffeinate_holds stdout ----

thread 'power::tests::caffeinate_holds' (9120970) panicked at src/power/mod.rs:5:9:
not supported on Linux yet
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

---- tests::breaks stdout ----

thread 'tests::breaks' (9120971) panicked at src/lib.rs:8:9:
assertion \`left == right\` failed
  left: 1
 right: 2


failures:
    power::tests::caffeinate_holds
    tests::breaks

test result: FAILED. 1 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--lib\`
`;

test("parseTestLog lists failed tests with their panic excerpt and reads the result line", () => {
  const parsed = parseTestLog(TEST_LOG);
  assert.deepEqual(parsed.result, { ok: false, passed: 1, failed: 2, ignored: 1 });
  assert.deepEqual(
    parsed.failed.map((t) => t.name),
    ["power::tests::caffeinate_holds", "tests::breaks"],
  );
  assert.deepEqual(parsed.failed[0].panic, [
    "thread 'power::tests::caffeinate_holds' (9120970) panicked at src/power/mod.rs:5:9:",
    "not supported on Linux yet",
  ]);
});

test("cargo's coloured stderr (CARGO_TERM_COLOR=always) is still recognised", () => {
  const log = [
    "\x1b[1m\x1b[91merror\x1b[0m: failed to run custom build command for `alsa-sys v0.3.1`",
    "  The system library `alsa` required by crate `alsa-sys` was not found.",
    "\x1b[1m\x1b[91merror\x1b[0m: could not compile `tosse-code` (lib) due to 1 previous error",
  ].join("\n");
  const parsed = parseCheckLog(log);
  assert.equal(parsed.strayBlocks.length, 1);
  assert.equal(parsed.strayBlocks[0][0], "error: failed to run custom build command for `alsa-sys v0.3.1`");
});

// Shapes from the first ubuntu-22.04 run: `ort`'s prebuilt ONNX Runtime wants a newer glibc.
const LLD_LOG = `\x1b[1m\x1b[91merror\x1b[0m: linking with \`cc\` failed: exit status: 1
  |
  = note: rust-lld: error: undefined symbol: __isoc23_strtoull
          >>> referenced by inference_session_utils.cc
          >>>               inference_session_utils.cc.o:(scan_number()) in archive /home/runner/work/FlightDeck/FlightDeck/src-tauri/target/debug/deps/libort_sys-e6774998e1326372.rlib
          >>> referenced 11 more times

          rust-lld: error: undefined symbol: __isoc23_strtoll
          >>> referenced by model_package_context.cc
          >>>               model_package_context.cc.o:(scan_number()) in archive /home/runner/work/FlightDeck/FlightDeck/src-tauri/target/debug/deps/libort_sys-e6774998e1326372.rlib
          collect2: error: ld returned 1 exit status

\x1b[1m\x1b[91merror\x1b[0m: could not compile \`tosse-code\` (lib test) due to 1 previous error; 2 warnings emitted
`;

test("parseTestLog reads an lld link failure: undefined symbols and the archive that wants them", () => {
  const parsed = parseTestLog(LLD_LOG);
  assert.equal(parsed.result, null);
  assert.deepEqual(parsed.link, {
    symbols: [
      { name: "__isoc23_strtoull", libs: ["ort_sys"] },
      { name: "__isoc23_strtoll", libs: ["ort_sys"] },
    ],
    missingLibs: [],
  });
});

test("parseTestLog reads GNU ld's undefined references and missing -l libraries", () => {
  const log = [
    "error: linking with `cc` failed: exit status: 1",
    "  = note: /usr/bin/ld: /work/target/debug/deps/libfoo_sys-0123456789abcdef.rlib(a.o): in function `go':",
    "          a.c:(.text+0x12): undefined reference to `bar_init'",
    "          /usr/bin/ld: cannot find -lasound: No such file or directory",
  ].join("\n");
  const parsed = parseTestLog(log);
  assert.deepEqual(parsed.link, { symbols: [{ name: "bar_init", libs: ["foo_sys"] }], missingLibs: ["asound"] });
});

test("parseTestLog without a result line means the binary never finished", () => {
  const parsed = parseTestLog("running 900 tests\ntest a ... ok\ntest b has been running for over 60 seconds\n");
  assert.equal(parsed.result, null);
  assert.equal(parsed.tail.at(-1), "test b has been running for over 60 seconds");
});

test("inlineMd escapes HTML outside code spans and pipes in table cells", () => {
  assert.equal(inlineMd("expected Vec<u8>, found `Vec<u8>`"), "expected Vec&lt;u8&gt;, found `Vec<u8>`");
  assert.equal(inlineMd("a | b `c|d`", { table: true }), "a \\| b `c\\|d`");
});

test("renderSummary for a failing check: counts, frequent errors, per-module details", () => {
  const libc = (file, line) =>
    diag({ code: "E0433", message: "cannot find module or crate `libc` in this scope", file, line });
  const check = parseCheckLog(
    [libc("src/power/mod.rs", 10), libc("src/terminal/mod.rs", 20), diag({ code: "E0425", message: "x", file: "src/power/mod.rs", line: 2 })].join(
      "\n",
    ),
  );
  const md = renderSummary({ os: "Linux (ubuntu-22.04)", checkOutcome: "failure", check, testOutcome: "skipped", test: null });
  assert.match(md, /^## Linux \(ubuntu-22\.04\)/);
  assert.match(md, /\| `cargo check --lib --tests` \| ❌ 3 errors in 2 files \|/);
  assert.match(md, /\| `cargo test --lib` \| ⏭️ not run \(does not compile yet\) \|/);
  assert.match(md, /\| 2 \| `E0433` cannot find module or crate `libc` in this scope \|/);
  assert.match(md, /\| power \| 2 \| 1 \|/);
  assert.match(md, /<b>power<\/b> — 2 errors in 1 file/);
  // Sorted by line inside a file.
  assert.ok(md.indexOf("- L2 `E0425` x") < md.indexOf("- L10 `E0433`"));
});

test("renderSummary for a green check and failing tests", () => {
  const md = renderSummary({
    os: "Windows (windows-latest)",
    checkOutcome: "success",
    check: parseCheckLog(""),
    testOutcome: "failure",
    test: parseTestLog(TEST_LOG),
  });
  assert.match(md, /\| `cargo check --lib --tests` \| ✅ compiles \|/);
  assert.match(md, /\| `cargo test --lib` \| ❌ 2 failed tests · 1 passed \|/);
  assert.match(md, /<b>power<\/b> — 1 test/);
  assert.match(md, /not supported on Linux yet/);
});

test("renderSummary explains a test binary that does not link", () => {
  const md = renderSummary({
    os: "Linux (ubuntu-22.04)",
    checkOutcome: "success",
    check: parseCheckLog(""),
    testOutcome: "failure",
    test: parseTestLog(LLD_LOG),
  });
  assert.match(md, /\| `cargo test --lib` \| ❌ the test binary does not link/);
  assert.match(md, /### Link errors/);
  assert.match(md, /\| `__isoc23_strtoull` \| `ort_sys` \|/);
  assert.match(md, /<summary>Test log tail<\/summary>/);
});

test("renderSummary shows the log tail when the test binary never finished", () => {
  const md = renderSummary({
    os: "Linux (ubuntu-22.04)",
    checkOutcome: "success",
    check: parseCheckLog(""),
    testOutcome: "failure",
    test: parseTestLog("running 900 tests\ntest b has been running for over 60 seconds\n"),
  });
  assert.match(md, /did not finish \(crash or timeout\)/);
  assert.doesNotMatch(md, /### Link errors/);
  assert.match(md, /test b has been running for over 60 seconds/);
});

test("renderSummary when the job died before the check ran", () => {
  const md = renderSummary({ os: "Linux (ubuntu-22.04)", checkOutcome: "", check: null, testOutcome: "", test: null });
  assert.match(md, /\| `cargo check --lib --tests` \| ⏭️ not run \(an earlier step failed\) \|/);
  assert.match(md, /\| `cargo test --lib` \| ⏭️ not run \(an earlier step failed\) \|/);
});
