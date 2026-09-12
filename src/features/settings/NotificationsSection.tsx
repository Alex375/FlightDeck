// "Notifications" section of the Settings panel. Three independently-toggleable
// channels fired when an agent finishes a turn or needs attention. Prefs live in
// the notifications store; the actual dispatch is in src/notifications/.
import { useNotifications } from "../../store/notifications";
import { testSound } from "../../notifications/notify";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

// `embedded` = rendered inside the Notifications tab's "Channels" sub-tab, which already
// carries the tab-level PageHead, so this drops its own.
export function NotificationsSection({ embedded = false }: { embedded?: boolean }) {
  const systemNotification = useNotifications((s) => s.systemNotification);
  const sound = useNotifications((s) => s.sound);
  const dockBounce = useNotifications((s) => s.dockBounce);
  const set = useNotifications((s) => s.set);

  return (
    <div>
      {!embedded && (
        <PageHead
          title="Notifications"
          subtitle="When an agent finishes its turn or needs your attention (permission, question). Nothing fires if you're already looking at the conversation in question."
        />
      )}

      <SettingsGroup title="Channels" icon="bell">
        <ToggleRow
          title="System notification"
          hint="A macOS banner in Notification Center."
          checked={systemNotification}
          onChange={(v) => set({ systemNotification: v })}
        />
        <ToggleRow
          title="Sound"
          hint="A soft chime."
          checked={sound}
          onChange={(v) => set({ sound: v })}
          action={
            <button
              type="button"
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => testSound("done")}
            >
              Test
            </button>
          }
        />
        <ToggleRow
          title="Dock bounce"
          hint="The Flight Deck icon bounces in the Dock."
          checked={dockBounce}
          onChange={(v) => set({ dockBounce: v })}
        />
      </SettingsGroup>
    </div>
  );
}
