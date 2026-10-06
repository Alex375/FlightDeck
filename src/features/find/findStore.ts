// ⌘F, routed to the panel the user is in.
//
// Every searchable surface — a conversation thread, a code editor, a markdown preview, a
// terminal, the Flight Deck, the TOSSE board — registers itself as a FIND HOST: the zone it
// covers (an element) and how to open its own find UI there. ⌘F then asks "which zone is the
// user in?" and opens THAT zone's find, anchored in the zone itself, never a free-floating
// popup somewhere else (see `routeFind`).
//
// The registry is module-level (not React state): it is read on a keystroke, never rendered.
// What IS rendered — which DOM find bar is open, and the query/toggles every bar shares — lives
// in the zustand store below.

import { create } from "zustand";
import { loadJson, saveJson } from "../../store/persist";
import { DEFAULT_FIND_OPTIONS, type FindHint, type FindOptions } from "./findQuery";
import { domVisible } from "./textIndex";

export interface FindHost {
  /** Unique while mounted. */
  id: string;
  /** The zone this host searches. Containment of the focused element decides routing. */
  el: () => HTMLElement | null;
  /** Open this host's find UI, seeded with `seed` when given. False = nothing searchable here
   *  right now (an image tab, an empty editor): the router then tries the next candidate. */
  open: (seed: string | null) => boolean;
  /** > 0: a default target of its view when focus is nowhere in particular (the body, a bare
   *  toolbar). Higher wins. The conversation thread is 1; the IDE's editor 2. */
  fallbackRank?: number;
}

const hosts = new Map<string, FindHost>();
/** The innermost host the user last pointed at or focused into — "where they are" when the
 *  focus itself sits on nothing searchable (a click on a non-focusable area leaves the body
 *  focused). */
let lastHostId: string | null = null;
let trackingInstalled = false;

function innermostHostOf(target: Node | null): FindHost | null {
  if (!target) return null;
  let best: FindHost | null = null;
  let bestEl: HTMLElement | null = null;
  for (const h of hosts.values()) {
    const el = h.el();
    if (!el || !el.contains(target)) continue;
    if (!bestEl || bestEl.contains(el)) {
      best = h;
      bestEl = el;
    }
  }
  return best;
}

function installTracking(): void {
  if (trackingInstalled || typeof window === "undefined") return;
  trackingInstalled = true;
  // A click OUTSIDE every zone (the sidebar, the title bar) forgets the last one too: the user
  // has left it, and ⌘F should then go to the view's default rather than back to it.
  const track = (e: Event) => {
    lastHostId = innermostHostOf(e.target as Node | null)?.id ?? null;
  };
  // Capture phase: a panel that stops propagation of its own clicks must not blind us.
  window.addEventListener("pointerdown", track, true);
  window.addEventListener("focusin", track, true);
}

/** Register a find host for as long as the caller is mounted. Returns the unregister. */
export function registerFindHost(host: FindHost): () => void {
  installTracking();
  hosts.set(host.id, host);
  return () => {
    if (hosts.get(host.id) === host) hosts.delete(host.id);
    if (lastHostId === host.id) lastHostId = null;
  };
}

/** Rendered-ness check — swappable because jsdom (the unit tests) has no layout at all. */
let isVisible: (el: Element) => boolean = domVisible;

function usable(h: FindHost): HTMLElement | null {
  const el = h.el();
  return el && el.isConnected && isVisible(el) ? el : null;
}

/** The topmost open modal (Settings, History, a popover…): the last rendered one wins. */
function topModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[aria-modal]:not([aria-modal="false"])');
  for (let i = all.length - 1; i >= 0; i--) if (isVisible(all[i])) return all[i];
  return null;
}

/** Try `first`, then the hosts nested inside it (an editor panel delegating to the markdown
 *  preview it shows), in document order. */
function openWithin(first: FindHost, seed: string | null, tried: Set<string>): boolean {
  tried.add(first.id);
  if (first.open(seed)) return true;
  const el = usable(first);
  if (!el) return false;
  const nested = [...hosts.values()]
    .filter((h) => !tried.has(h.id) && usable(h) && el.contains(h.el()!) && h.el() !== el)
    .sort((a, b) => (a.el()!.compareDocumentPosition(b.el()!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const h of nested) {
    tried.add(h.id);
    if (h.open(seed)) return true;
  }
  return false;
}

/**
 * Route ⌘F. Candidates, in order:
 *  1. the hosts containing the focused element, innermost first (each may delegate inward);
 *  2. the host last pointed at / focused into, if still on screen;
 *  3. the view's fallback hosts, by rank.
 * An open modal confines all of it to the hosts inside it — ⌘F must never open a find bar
 * BEHIND Settings or the History panel. A modal with no host but its own search box gets that
 * box focused instead (Settings, History).
 *
 * `"opened"`: a find UI is up (the caller swallows the key). `"unsupported"`: the user is IN a
 * searchable zone that has nothing to search right now (an image or a PDF tab) — we do NOT
 * fall through to another panel: ⌘F on an image must not quietly search the conversation next
 * to it. `"none"`: nothing on screen is searchable.
 */
export type FindRoute = "opened" | "unsupported" | "none";

export function routeFind(focused: Element | null, seed: string | null): FindRoute {
  const modal = topModal();
  const inScope = (h: FindHost): boolean => {
    const el = usable(h);
    return !!el && (!modal || modal.contains(el));
  };
  const tried = new Set<string>();

  const containing = [...hosts.values()]
    .filter((h) => inScope(h) && focused && h.el()!.contains(focused))
    .sort((a, b) => (a.el()!.contains(b.el()!) ? 1 : -1)); // inner first
  for (const h of containing) if (!tried.has(h.id) && openWithin(h, seed, tried)) return "opened";
  if (containing.length > 0) return "unsupported";

  const last = lastHostId ? hosts.get(lastHostId) : undefined;
  if (last && !tried.has(last.id) && inScope(last)) {
    if (openWithin(last, seed, tried)) return "opened";
    return "unsupported";
  }

  const fallbacks = [...hosts.values()]
    .filter((h) => (h.fallbackRank ?? 0) > 0 && !tried.has(h.id) && inScope(h))
    .sort((a, b) => (b.fallbackRank ?? 0) - (a.fallbackRank ?? 0));
  for (const h of fallbacks) if (openWithin(h, seed, tried)) return "opened";

  if (modal) {
    const box = modal.querySelector<HTMLInputElement>('[data-find-input], input[type="search"]');
    if (box) {
      box.focus();
      box.select();
      return "opened";
    }
  }
  return "none";
}

// ---- Shared find state ------------------------------------------------------------------

const STORAGE_KEY = "tosse:find";

interface Persisted extends FindOptions {
  /** The last query typed in any bar — what a fresh bar starts with when nothing is selected
   *  (the macOS "find pasteboard" habit: ⌘F anywhere resumes the last search). */
  query: string;
  /** Conversations in clean output: also search the work folded away. Sticky. */
  includeFolded: boolean;
}

const DEFAULTS: Persisted = { ...DEFAULT_FIND_OPTIONS, query: "", includeFolded: false };

function load(): Persisted {
  const raw = loadJson<Partial<Persisted>>(STORAGE_KEY, {});
  return {
    query: typeof raw.query === "string" ? raw.query : "",
    isRegex: raw.isRegex === true,
    matchCase: raw.matchCase === true,
    wholeWord: raw.wholeWord === true,
    includeFolded: raw.includeFolded === true,
  };
}

/** Extras for a bar opened ON BEHALF of something else (a global-search hit), not by ⌘F. */
export interface OpenExtras {
  /** Land on the hit with this context (see pickByHint). */
  hint?: FindHint | null;
  /** If nothing visible matches, open the conversation's folded work on its own (the hit came
   *  from an assistant message, which clean output may well have folded away). */
  autoFold?: boolean;
}

/** A find waiting for its surface to mount — a conversation the global search is opening. */
export interface PendingFind extends OpenExtras {
  /** The surface's stable `id` (useDomFind's `cfg.id`, e.g. `conv:<id>`). */
  surfaceId: string;
  at: number;
}

interface FindState extends Persisted {
  /** The DOM find bar on screen (one at a time: highlights are app-global), with a nonce that
   *  re-focuses it when ⌘F is pressed again while it is already open. */
  active: ({ hostId: string; nonce: number } & OpenExtras) | null;
  pending: PendingFind | null;
  openBar: (hostId: string, seed: string | null, extras?: OpenExtras) => void;
  closeBar: (hostId: string) => void;
  setQuery: (query: string) => void;
  setOptions: (patch: Partial<FindOptions & { includeFolded: boolean }>) => void;
  /** Open a surface's find bar as soon as it is on screen, with this query and these toggles. */
  requestFind: (surfaceId: string, query: string, options: FindOptions, extras?: OpenExtras) => void;
  clearPending: () => void;
}

const initial = typeof localStorage === "undefined" ? DEFAULTS : load();

export const useFindStore = create<FindState>((set, get) => {
  const persist = () => {
    const s = get();
    saveJson(STORAGE_KEY, {
      query: s.query,
      isRegex: s.isRegex,
      matchCase: s.matchCase,
      wholeWord: s.wholeWord,
      includeFolded: s.includeFolded,
    } satisfies Persisted);
  };
  return {
    ...initial,
    active: null,
    pending: null,
    openBar: (hostId, seed, extras) => {
      set((s) => ({
        active: { hostId, nonce: (s.active?.nonce ?? 0) + 1, ...extras },
        ...(seed ? { query: seed } : {}),
      }));
      if (seed) persist();
    },
    closeBar: (hostId) => set((s) => (s.active?.hostId === hostId ? { active: null } : s)),
    setQuery: (query) => {
      set({ query });
      persist();
    },
    setOptions: (patch) => {
      set(patch);
      persist();
    },
    requestFind: (surfaceId, query, options, extras) => {
      set({ query, ...options, pending: { surfaceId, at: Date.now(), ...extras } });
      persist();
    },
    clearPending: () => set({ pending: null }),
  };
});

/** Test seam: forget every registered host and the last-pointed one, and swap the
 *  visibility check (jsdom renders nothing, so every element would read as hidden). */
export function __resetFindHostsForTests(visible: (el: Element) => boolean = () => true): void {
  hosts.clear();
  lastHostId = null;
  isVisible = visible;
}
