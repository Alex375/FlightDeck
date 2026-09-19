import { Ico } from "../../ui/kit";
import { CONVERSATION_PANEL_CHORD } from "../../ui/shortcuts";
import { useConvPanelShown, useEditorStore } from "../editor/editorStore";

/**
 * Title-bar toggle for the conversation side panel (the far-right column holding the
 * conversation's state). Mirrors EditorToggle/TerminalToggle: a `wf-icon-btn` that goes
 * `.on` while the panel is ON SCREEN — a panel that stepped aside for lack of room reads as
 * off, and pressing the toggle brings it back. Also bound to {@link CONVERSATION_PANEL_CHORD}.
 */
export function ConversationPanelToggle() {
  const open = useConvPanelShown();
  const toggle = useEditorStore((s) => s.toggleConvPanel);

  return (
    <button
      type="button"
      className={"wf-icon-btn" + (open ? " on" : "")}
      data-on={open ? "" : undefined}
      onClick={toggle}
      title={`${open ? "Close" : "Open"} the conversation panel (${CONVERSATION_PANEL_CHORD})`}
      aria-label="Toggle the conversation panel"
    >
      <Ico name="sidebarR" className="sm" />
    </button>
  );
}
