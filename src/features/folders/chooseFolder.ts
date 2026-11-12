// Choosing a folder on THIS Mac — the one entry point for every "pick a folder here" in the
// app: a new conversation, a folder opened in the IDE, a folder added to search, a TOSSE
// project's folder. Flight Deck's folder browser by default (the one a server's folders
// are chosen with), the system picker when the "folder browser" preference is off.
//
// The browser is a dialog, but callers want a promise (`await chooseFolder(…)`), as they
// had with the system picker: a request is parked here and `FolderChooserHost`, mounted
// once at the app's root, renders it and settles it.
import { create } from "zustand";
import { pickFolder } from "../../ipc/pickFolder";
import { useDisplay } from "../../store/display";

export interface ChooseFolderRequest {
  /** What the folder is for — the dialog's title (and the system picker's). */
  title: string;
  /** Under the title; "On this Mac" when absent. */
  hint?: string;
  /** The button that hands the folder back. "Choose" when absent. */
  confirmLabel?: string;
  /** What the footer calls the chosen folder. "Folder" when absent. */
  targetLabel?: string;
}

export interface PendingFolderChoice extends ChooseFolderRequest {
  id: number;
  resolve: (path: string | null) => void;
}

export const useFolderChooser = create<{ pending: PendingFolderChoice | null }>(() => ({ pending: null }));

let seq = 0;

/** The chosen absolute folder, or null when cancelled. */
export function chooseFolder(req: ChooseFolderRequest): Promise<string | null> {
  if (!useDisplay.getState().folderBrowser) return pickFolder(req.title);
  return new Promise((resolve) => {
    // One dialog at a time: a second ask answers the first one "cancelled".
    useFolderChooser.getState().pending?.resolve(null);
    useFolderChooser.setState({ pending: { ...req, id: ++seq, resolve } });
  });
}

/** Answer the open request `id` (a folder, or null for cancelled) and close its dialog. */
export function settleFolderChoice(id: number, path: string | null): void {
  const p = useFolderChooser.getState().pending;
  if (!p || p.id !== id) return;
  useFolderChooser.setState({ pending: null });
  p.resolve(path);
}

/** Close the browser and answer request `id` with the system picker instead — for a folder
 *  the browser can't reach, or a person who'd rather use the one they know. */
export async function switchToSystemPicker(id: number): Promise<void> {
  const p = useFolderChooser.getState().pending;
  if (!p || p.id !== id) return;
  useFolderChooser.setState({ pending: null });
  p.resolve(await pickFolder(p.title));
}
