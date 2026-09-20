import { Ico } from "../../ui/kit";
import { useEditorLayout, useEditorStore, useSideRegionOpen } from "./editorStore";

/**
 * Title-bar controls for the editor panel: a toggle to open/close it, and — when the side
 * region shows anything (editor, terminal, the Git workspace, an artifact or a TOSSE task)
 * — a toggle to switch its placement between side-by-side and stacked. In Git mode the
 * orientation button drives the Git workspace's own orientation (`gitOrientation`);
 * otherwise the side region's (`orientation`), which an open artifact or task follows too.
 */
export function EditorToggle({ convId }: { convId: string }) {
  const { open, gitOpen, orientation, gitOrientation } = useEditorLayout();
  const toggleOpen = useEditorStore((s) => s.toggleOpen);
  const setOrientation = useEditorStore((s) => s.setOrientation);
  const setGitOrientation = useEditorStore((s) => s.setGitOrientation);
  const sideOpen = useSideRegionOpen(convId);
  const curOrientation = gitOpen ? gitOrientation : orientation;
  const flipOrientation = () => {
    const next = curOrientation === "row" ? "column" : "row";
    if (gitOpen) setGitOrientation(next);
    else setOrientation(next);
  };

  return (
    <>
      {sideOpen ? (
        <button
          type="button"
          className="wf-icon-btn"
          onClick={flipOrientation}
          title={curOrientation === "row" ? "Stacked layout (top/bottom)" : "Side-by-side layout"}
          aria-label="Change panel layout"
        >
          <Ico name={curOrientation === "row" ? "splitv" : "splith"} className="sm" />
        </button>
      ) : null}
      <button
        type="button"
        className={"wf-icon-btn" + (open ? " on" : "")}
        data-on={open ? "" : undefined}
        onClick={toggleOpen}
        title={open ? "Close editor" : "Open file editor"}
        aria-label="Toggle file editor"
      >
        <Ico name="code" className="sm" />
      </button>
    </>
  );
}
