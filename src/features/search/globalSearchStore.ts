// State of the ⌘⇧F "search everywhere" panel: open/closed, and everything the user set up in
// it — query, toggles, what to search (conversations / files), which folders. All of it is
// remembered (localStorage `tosse:globalsearch`): reopening the panel resumes the last search,
// the way an editor's search view does. Results are NOT kept here — they are transient, owned
// by the panel.
import { create } from "zustand";
import { loadJson, saveJson } from "../../store/persist";
import { DEFAULT_FIND_OPTIONS, type FindOptions } from "../find/findQuery";

const STORAGE_KEY = "tosse:globalsearch";

/** A folder added to the search by hand (the OS picker), on top of the app's repositories. */
export interface ExtraFolder {
  path: string;
  on: boolean;
}

interface Persisted extends FindOptions {
  query: string;
  conversations: boolean;
  files: boolean;
  include: string;
  exclude: string;
  /** Repositories the user UNticked. Stored as exclusions so a repository added later is
   *  searched by default rather than silently left out. */
  excludedRepoIds: string[];
  extraFolders: ExtraFolder[];
}

const DEFAULTS: Persisted = {
  ...DEFAULT_FIND_OPTIONS,
  query: "",
  conversations: true,
  files: true,
  include: "",
  exclude: "",
  excludedRepoIds: [],
  extraFolders: [],
};

function load(): Persisted {
  const raw = loadJson<Partial<Persisted>>(STORAGE_KEY, {});
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    query: str(raw.query, ""),
    isRegex: bool(raw.isRegex, false),
    matchCase: bool(raw.matchCase, false),
    wholeWord: bool(raw.wholeWord, false),
    conversations: bool(raw.conversations, true),
    files: bool(raw.files, true),
    include: str(raw.include, ""),
    exclude: str(raw.exclude, ""),
    excludedRepoIds: Array.isArray(raw.excludedRepoIds)
      ? raw.excludedRepoIds.filter((x): x is string => typeof x === "string")
      : [],
    extraFolders: Array.isArray(raw.extraFolders)
      ? raw.extraFolders.filter(
          (f): f is ExtraFolder => !!f && typeof f.path === "string" && typeof f.on === "boolean",
        )
      : [],
  };
}

interface GlobalSearchState extends Persisted {
  open: boolean;
  /** Bumped on every open, so a re-open focuses and selects the query box again. */
  openNonce: number;
  /** Open the panel; a one-line selection becomes the query (like ⌘F does). */
  openPanel: (seed?: string | null) => void;
  closePanel: () => void;
  set: (patch: Partial<Persisted>) => void;
  toggleRepo: (repoId: string) => void;
  /** Add a folder picked by hand (ticked). Idempotent on the path. */
  addFolder: (path: string) => void;
  toggleFolder: (path: string) => void;
  removeFolder: (path: string) => void;
}

const initial = typeof localStorage === "undefined" ? DEFAULTS : load();

export const useGlobalSearch = create<GlobalSearchState>((set, get) => {
  const persist = () => {
    const s = get();
    const out: Persisted = {
      query: s.query,
      isRegex: s.isRegex,
      matchCase: s.matchCase,
      wholeWord: s.wholeWord,
      conversations: s.conversations,
      files: s.files,
      include: s.include,
      exclude: s.exclude,
      excludedRepoIds: s.excludedRepoIds,
      extraFolders: s.extraFolders,
    };
    saveJson(STORAGE_KEY, out);
  };
  const update = (patch: Partial<Persisted>) => {
    set(patch);
    persist();
  };
  return {
    ...initial,
    open: false,
    openNonce: 0,
    openPanel: (seed) =>
      set((s) => ({ open: true, openNonce: s.openNonce + 1, ...(seed ? { query: seed } : {}) })),
    closePanel: () => set({ open: false }),
    set: update,
    toggleRepo: (repoId) => {
      const ex = get().excludedRepoIds;
      update({ excludedRepoIds: ex.includes(repoId) ? ex.filter((x) => x !== repoId) : [...ex, repoId] });
    },
    addFolder: (path) => {
      const folders = get().extraFolders;
      const existing = folders.find((f) => f.path === path);
      update({
        extraFolders: existing
          ? folders.map((f) => (f.path === path ? { ...f, on: true } : f))
          : [...folders, { path, on: true }],
      });
    },
    toggleFolder: (path) =>
      update({ extraFolders: get().extraFolders.map((f) => (f.path === path ? { ...f, on: !f.on } : f)) }),
    removeFolder: (path) => update({ extraFolders: get().extraFolders.filter((f) => f.path !== path) }),
  };
});
