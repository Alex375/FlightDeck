// Where the folder browser reads from: a paired server (over SSH) or this Mac. One dialog,
// two sources with the same three reads — so a folder is chosen the same way wherever it
// lives.
import { commands, type FolderListing } from "../../ipc/client";
import { outcome, type Outcome } from "../../ipc/outcome";
import { useConversationsStore } from "../../store/conversationsStore";
import { IS_MAC } from "../../ui/platform";

/** The repositories a source found, and anything the browser should say about the search. */
export interface RepoSearch {
  paths: string[];
  /** Shown under the list: where the search did NOT look, or that it stopped early. */
  note: string | null;
}

export interface FolderSource {
  /** One folder (`""` = the home folder). A folder that isn't there is a listing with
   *  `exists: false`, not an error. */
  list(path: string): Promise<Outcome<FolderListing>>;
  /** The git repositories worth offering up front. */
  findRepos(): Promise<Outcome<RepoSearch>>;
  /** Create the LAST folder of `path` when its parent exists; a folder already there is
   *  fine. */
  makeDir(path: string): Promise<Outcome<null>>;
  /** Where the repository search looks, for the "none found" line. */
  searchedWhere: string;
}

/** A paired server's folders. */
export function remoteFolderSource(machineId: string): FolderSource {
  const store = () => useConversationsStore.getState();
  return {
    list: (path) => store().listRemoteDir(machineId, path),
    findRepos: async () => {
      const res = await store().listRemoteRepos(machineId);
      return res.ok ? { ok: true, data: { paths: res.data, note: null } } : res;
    },
    makeDir: async (path) => {
      const res = await store().prepareRemoteDir(machineId, path);
      return res.ok ? { ok: true, data: null } : res;
    },
    searchedWhere: "Searched ~, /work, /srv, /opt and /var/www, four levels deep.",
  };
}

/** Why the search on this Mac leaves some folders out — said under the list, so an absent
 *  repository is never mistaken for "there is none". */
export const GUARDED_FOLDERS_NOTE = IS_MAC
  ? "Desktop, Documents and Downloads aren't searched: macOS would ask for access first. Open them to look inside."
  : null;

/** This Mac's folders. */
export const localFolderSource: FolderSource = {
  list: (path) => outcome(() => commands.listLocalDir(path)),
  findRepos: async () => {
    const res = await outcome(() => commands.listLocalRepos());
    if (!res.ok) return res;
    const stopped = res.data.truncated ? "The search stopped after 3 seconds, so some may be missing." : null;
    const note = [stopped, GUARDED_FOLDERS_NOTE].filter(Boolean).join(" ") || null;
    return { ok: true, data: { paths: res.data.paths, note } };
  },
  makeDir: (path) => outcome(() => commands.prepareLocalDir(path)),
  searchedWhere: "Searched your home folder and next to the folders already in Flight Deck, four levels deep.",
};
