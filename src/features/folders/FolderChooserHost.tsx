// Renders the folder browser for this Mac when `chooseFolder` asks for it — mounted once at
// the app's root, so any feature can await a folder without owning a dialog.
import { MACHINE } from "../../ui/platform";
import { FolderBrowserDialog } from "./FolderBrowser";
import { settleFolderChoice, switchToSystemPicker, useFolderChooser } from "./chooseFolder";
import { localFolderSource } from "./folderSources";
import styles from "./FolderBrowser.module.css";

const THIS_MACHINE = `this ${MACHINE}`;

export function FolderChooserHost() {
  const pending = useFolderChooser((s) => s.pending);
  if (!pending) return null;
  const { id } = pending;
  return (
    <FolderBrowserDialog
      key={id}
      source={localFolderSource}
      place={THIS_MACHINE}
      badge="laptop"
      title={pending.title}
      subtitle={<span>{pending.hint ?? `On this ${MACHINE}`}</span>}
      confirmLabel={pending.confirmLabel ?? "Choose"}
      targetLabel={pending.targetLabel ?? "Folder"}
      footerExtra={
        <button
          type="button"
          className={`${styles.btn} ${styles.btnQuiet}`}
          onClick={() => void switchToSystemPicker(id)}
          title="Choose with the system's folder picker instead"
        >
          System picker…
        </button>
      }
      onOpen={(path) => settleFolderChoice(id, path)}
      onClose={() => settleFolderChoice(id, null)}
    />
  );
}
