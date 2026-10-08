// Owns the live xterm.js terminals, keyed by conversation id, OUTSIDE React. The
// React view (TerminalView) only attaches/detaches a long-lived host element into
// the DOM — the Terminal instance, its scrollback and its PTY keep living when the
// panel is closed or another conversation is shown, so a running command isn't
// killed by toggling the terminal off. The matching PTY lives in the Rust core
// (terminal/mod.rs); this module is the front half: render + input + lifecycle.
//
// Output arrives as a single global `TerminalOutputEvent` stream keyed by id
// (mirrors useGlobalSessionEvents): we route each chunk to its terminal even while
// detached, so nothing is lost. Base64 → bytes → `term.write(bytes)` lets xterm's
// own decoder reassemble UTF-8 sequences split across chunks.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { commands, events } from "../../ipc/client";
import { registerTerminalDisposers } from "./cleanup";

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  /** A detached div that owns xterm's DOM; reparented in/out of the React tree. */
  host: HTMLDivElement;
  /** Whether `term.open` has run on `host` yet. */
  opened: boolean;
  /** The shell has exited (EOF on the PTY) — a re-open restarts it. */
  exited: boolean;
  /** The live WebGL renderer, or null if this terminal is on the DOM renderer
   *  (never got a context, lost it, or was evicted to stay under the budget). */
  webgl: WebglAddon | null;
  /** The ⌘F search addon, loaded lazily by `searchAddonFor`. */
  search?: SearchAddon;
}

const entries = new Map<string, TermEntry>();
let listenersReady = false;

/** Browsers cap the number of simultaneous live WebGL contexts (≈16 in
 *  Chromium/WebKit); past it the OLDEST is dropped, which would silently degrade a
 *  random older terminal to the DOM renderer for good. We instead keep an explicit
 *  LRU budget below that cap and evict deliberately, so a re-shown terminal gets
 *  WebGL back. 8 leaves headroom for any other GL user in the webview. */
const MAX_WEBGL = 8;
/** Ids of terminals with a live WebGL renderer, least-recently-attached first. */
const webglOrder: string[] = [];

/** Mark `id` as the most-recently-used WebGL terminal. */
function touchWebgl(id: string): void {
  const i = webglOrder.indexOf(id);
  if (i !== -1) webglOrder.splice(i, 1);
  webglOrder.push(id);
}

/** Drop a terminal's WebGL renderer (falls back to the DOM renderer) and forget it
 *  in the LRU. The Terminal and its scrollback stay intact; a later attach re-adds
 *  WebGL. No-op if it had none. */
function dropWebgl(entry: TermEntry, id: string): void {
  const i = webglOrder.indexOf(id);
  if (i !== -1) webglOrder.splice(i, 1);
  if (entry.webgl) {
    try {
      entry.webgl.dispose();
    } catch {
      /* already gone */
    }
    entry.webgl = null;
  }
}

/** Ensure terminal `id` has a live WebGL renderer (creating one if missing) and keep
 *  the total number of live contexts within `MAX_WEBGL` by evicting the least-recently
 *  -used. Must run AFTER `term.open`. Silently leaves the terminal on the DOM renderer
 *  if the webview can't give a context. */
function ensureWebgl(id: string, entry: TermEntry): void {
  if (entry.webgl) {
    touchWebgl(id);
    return;
  }
  try {
    const webgl = new WebglAddon();
    // On context loss the browser reclaimed our GL context: fall back to DOM and
    // forget it so a future attach can re-create one.
    webgl.onContextLoss(() => dropWebgl(entry, id));
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
    touchWebgl(id);
  } catch {
    /* no WebGL — xterm keeps its default DOM renderer */
    return;
  }
  // Evict beyond the budget: dispose only the addon of the least-recently-used
  // terminal (never the one we just attached) → it drops to the DOM renderer.
  while (webglOrder.length > MAX_WEBGL && webglOrder[0] !== id) {
    const lruId = webglOrder[0];
    const lru = entries.get(lruId);
    if (lru) dropWebgl(lru, lruId);
    else webglOrder.shift();
  }
}

/** Decode a base64 PTY chunk to bytes (atob → Uint8Array). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Register the global PTY output/exit listeners once (app-lifetime, never torn
 *  down — like the Rust tick listener). Routes each event to its terminal by id. */
function ensureListeners(): void {
  if (listenersReady) return;
  listenersReady = true;
  void events.terminalOutputEvent.listen((e) => {
    const entry = entries.get(e.payload.id);
    if (entry) entry.term.write(b64ToBytes(e.payload.data));
  });
  void events.terminalExitEvent.listen((e) => {
    const entry = entries.get(e.payload.id);
    if (!entry || entry.exited) return;
    entry.exited = true;
    // Dim notice; the shell is gone until the panel is reopened (which restarts it).
    entry.term.write("\r\n\x1b[2m[process ended — reopen the terminal to start a new one]\x1b[0m\r\n");
  });
}

/** Build an xterm theme from the app's CSS tokens so the terminal matches the UI. */
function makeTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--wf-bg", "#0c0c0f"),
    foreground: v("--wf-tx", "#a6a6b0"),
    cursor: v("--wf-accent", "#d97757"),
    cursorAccent: v("--wf-bg", "#0c0c0f"),
    selectionBackground: v("--wf-panel-3", "#20202a"),
    brightBlack: v("--wf-tx-xlo", "#4a4a55"),
  };
}

/** Spawn the PTY for `id` rooted at `cwd`, at the terminal's current grid size. */
function spawnPty(id: string, cwd: string, term: Terminal): void {
  void commands.terminalOpen(id, cwd, term.cols || 80, term.rows || 24).then((res) => {
    if (res.status === "error") {
      term.write(`\r\n\x1b[31mFailed to start the terminal: ${res.error}\x1b[0m\r\n`);
      const entry = entries.get(id);
      if (entry) entry.exited = true;
    }
  });
}

/** Get (creating if needed) the terminal for `id`. If its shell had exited, the
 *  same surface is reused and a fresh shell is spawned (restart on re-open). */
export function ensureTerm(id: string, cwd: string): TermEntry {
  ensureListeners();
  const existing = entries.get(id);
  if (existing) {
    if (existing.exited) {
      existing.exited = false;
      existing.term.reset();
      spawnPty(id, cwd, existing.term);
    }
    return existing;
  }

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontFamily: cs.getPropertyValue("--wf-mono").trim() || "ui-monospace, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.15,
    theme: makeTheme(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";

  const entry: TermEntry = { term, fit, host, opened: false, exited: false, webgl: null };
  entries.set(id, entry);

  // Keystrokes / paste → PTY.
  term.onData((data) => void commands.terminalWrite(id, data));
  spawnPty(id, cwd, term);
  return entry;
}

/** Attach a terminal's host into `container`, opening it the first time and
 *  keeping it fitted to the container size (splitter drags, window resizes).
 *  Returns a detach cleanup that leaves the Terminal alive. */
export function attachTerm(id: string, container: HTMLElement): () => void {
  const entry = entries.get(id);
  if (!entry) return () => {};
  const { term, fit, host } = entry;
  const firstOpen = !entry.opened;
  container.appendChild(host);

  if (firstOpen) {
    term.open(host);
    entry.opened = true;
  }
  // (Re)attach a WebGL renderer within the live-context budget. Done on EVERY attach,
  // not just the first: a terminal that lost its context — or was evicted when many
  // terminals were open — gets WebGL back the next time it's shown (and is marked
  // most-recently-used so it isn't the next one evicted).
  ensureWebgl(id, entry);

  const doFit = () => {
    try {
      fit.fit();
      void commands.terminalResize(id, term.cols, term.rows);
    } catch {
      /* container not measurable yet — a later ResizeObserver tick will fit */
    }
  };
  // Fit now and again next frame (the flex container may not have its size yet).
  doFit();
  const raf = requestAnimationFrame(doFit);
  const ro = new ResizeObserver(() => doFit());
  ro.observe(container);
  // Focus only on the FIRST reveal of this terminal (the user just opened/switched
  // to it). Never on a later re-attach: re-attaches are also driven by background
  // agent activity (a cwd move) and stealing focus mid-typing would misroute keys.
  if (firstOpen) term.focus();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    if (host.parentElement) host.parentElement.removeChild(host);
  };
}

/** The search addon of terminal `id`, loaded on first use (⌘F in that terminal) — most
 *  terminals are never searched, so none pays for it up front. Null when the terminal does
 *  not exist. */
export function searchAddonFor(id: string): SearchAddon | null {
  const entry = entries.get(id);
  if (!entry) return null;
  if (!entry.search) {
    entry.search = new SearchAddon({ highlightLimit: 1000 });
    entry.term.loadAddon(entry.search);
  }
  return entry.search;
}

/** Give terminal `id` the keyboard back (closing its find bar). */
export function focusTerm(id: string): void {
  entries.get(id)?.term.focus();
}

/** Tear a terminal down for good (e.g. its conversation was deleted): kill the
 *  shell and dispose the xterm instance. Safe no-op when the conversation never
 *  opened a terminal. */
export function disposeTerm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  // Drop it from the WebGL LRU (term.dispose disposes the addon itself).
  const oi = webglOrder.indexOf(id);
  if (oi !== -1) webglOrder.splice(oi, 1);
  void commands.terminalClose(id);
  try {
    entry.term.dispose();
  } catch {
    /* already disposed */
  }
}

/** Dispose every live terminal (wipe-all / bulk delete) — kills all shells and
 *  frees all xterm instances. */
export function disposeAllTerms(): void {
  for (const id of [...entries.keys()]) disposeTerm(id);
}

// Wire the disposers into the decoupling shim so the (eagerly-loaded) conversation
// store can clean up terminals on delete/wipe without importing xterm at startup.
registerTerminalDisposers(disposeTerm, disposeAllTerms);
