// The remote stand-in for the native folder picker: choose a folder on a paired SSH
// server to open a conversation in. Reused by the Settings "Remote servers" card AND
// the sidebar's "+ new conversation" flow, so the two stay identical.
//
//  - detected git repos → one-click quick pick,
//  - a click-to-descend folder browser (../ + sub-folders), populated over SSH,
//  - a path field pre-filled with the server's REAL $HOME,
//  - create-if-missing: opening a path mkdir's ONLY the final folder, and only when its
//    parent exists (a wrong parent chain fails loudly instead of materialising a bogus
//    deep path).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConversationsStore } from "../../store/conversationsStore";
import styles from "./SettingsPanel.module.css";

/** The parent of a POSIX path, or null at the root. */
export function parentDir(p: string): string | null {
  if (!p || p === "/") return null;
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
/** Join a directory and a child name into a POSIX path. */
export function joinDir(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export function RemoteFolderPicker({
  machineId,
  machineLabel,
  onOpen,
}: {
  machineId: string;
  machineLabel: string;
  /** Called with a validated (existing-or-just-created) remote folder path. */
  onOpen: (path: string) => void;
}) {
  const [repos, setRepos] = useState<string[] | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<string[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const browseTo = useCallback(
    async (p: string) => {
      setBrowseDirs(null);
      const listing = await useConversationsStore.getState().listRemoteDir(machineId, p);
      if (!listing) return;
      setBrowsePath(listing.path);
      setBrowseDirs(listing.dirs);
      setPath(listing.path); // the field tracks the browsed folder → "Open here"
    },
    [machineId],
  );

  // On mount: detect git repos AND open the browser at the real $HOME (so the path
  // field starts from a folder that actually exists, not a made-up example).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const store = useConversationsStore.getState();
      const [r] = await Promise.all([store.listRemoteRepos(machineId), browseTo("")]);
      if (alive) {
        setRepos(r);
        setDetecting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [machineId, browseTo]);

  const open = useCallback(
    async (p: string) => {
      const t = p.trim();
      if (!t) return;
      setError(null);
      // mkdir the LEAF if it doesn't exist and its parent does (NOT mkdir -p).
      const prep = await useConversationsStore.getState().prepareRemoteDir(machineId, t);
      if (!prep.ok) {
        setError(prep.error);
        return;
      }
      onOpen(t);
    },
    [machineId, onOpen],
  );

  return (
    <>
      {detecting && (
        <div className={styles.remoteStep}>
          Looking at <b>{machineLabel}</b>…
        </div>
      )}

      {repos && repos.length > 0 && (
        <>
          <div className={styles.remoteStep}>
            Repositories detected on <b>{machineLabel}</b>:
          </div>
          <div className={styles.repoList}>
            {repos.map((p) => (
              <button key={p} className={styles.repoOption} onClick={() => void open(p)}>
                {p}
              </button>
            ))}
          </div>
        </>
      )}

      <div className={styles.remoteStep}>
        Or browse <b>{machineLabel}</b>
        {browsePath ? <> — {browsePath}</> : null}:
      </div>
      <div className={styles.repoList}>
        {parentDir(browsePath) && (
          <button
            className={styles.repoOption}
            onClick={() => void browseTo(parentDir(browsePath)!)}
          >
            ../
          </button>
        )}
        {browseDirs === null ? (
          <div className={styles.remoteStep}>…</div>
        ) : browseDirs.length === 0 ? (
          <div className={styles.remoteStep}>(no sub-folders here)</div>
        ) : (
          browseDirs.map((d) => (
            <button
              key={d}
              className={styles.repoOption}
              onClick={() => void browseTo(joinDir(browsePath, d))}
            >
              {d}/
            </button>
          ))
        )}
      </div>

      <div className={styles.remoteStep}>
        Folder for the conversation (created if it doesn't exist yet — only the last folder,
        so the parent must be right):
      </div>
      <div className={styles.fieldRow}>
        <input
          className={styles.field}
          placeholder="/home/you/project"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void open(path);
          }}
        />
        <button
          className={`${styles.btn} ${styles.primary}`}
          disabled={!path.trim()}
          onClick={() => void open(path)}
        >
          Open here
        </button>
      </div>
      {error && <div className={styles.errorMsg}>{error}</div>}
    </>
  );
}

/** The folder picker in a modal (portal to body), for the sidebar's "+ new conversation
 *  on a server" flow. Escape or a scrim click cancels. */
export function RemoteFolderDialog({
  machine,
  onOpen,
  onClose,
}: {
  machine: { id: string; label: string };
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body: ReactNode = (
    <div className={styles.rfdScrim} onClick={onClose}>
      <div className={styles.rfdPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.rfdHead}>New conversation on {machine.label}</div>
        <div className={styles.rfdBody}>
          <RemoteFolderPicker machineId={machine.id} machineLabel={machine.label} onOpen={onOpen} />
        </div>
        <div className={styles.btnRow}>
          <button className={`${styles.btn} ${styles.ghost}`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
