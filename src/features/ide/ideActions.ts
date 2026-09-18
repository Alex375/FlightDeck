// What the conversation-scoped chords mean INSIDE the IDE view. The keys keep their
// sense rather than their target: ⌘B still shows/hides "the files", ⌘J still opens/closes
// "the panel at the bottom" — they just drive the IDE's explorer and dock instead of the
// conversation view's side region, which is not on screen here.
import { runAppAction } from "../../ui/appActions";
import type { ShortcutAction } from "../../ui/shortcuts";
import { useIdeStore } from "./ideStore";

/** Run a conversation-scoped action in the IDE view. Returns whether it did something, so
 *  the keyboard handler only swallows the key when it acted. */
export function runIdeAction(action: ShortcutAction): boolean {
  const ide = useIdeStore.getState();
  const ws = ide.workspaces.find((w) => w.id === ide.activeId);
  if (!ws) return false;
  switch (action) {
    case "toggle-editor":
      ide.setTreeCollapsed(!ide.treeCollapsed);
      return true;
    case "toggle-terminal":
      ide.toggleDock();
      return true;
    case "toggle-clean-output":
    case "open-extensions": {
      // These act on a conversation — and only the one DOCKED HERE counts, which is not
      // necessarily the app's active one (see `dockedConversation`). `watchedConvId` is
      // exactly "the conversation this dock has on screen": null with the dock closed or
      // on Terminals, where acting would change something the user cannot see.
      const docked = ide.watchedConvId;
      return docked ? runAppAction(action, { convId: docked }) : false;
    }
    default:
      return false;
  }
}
