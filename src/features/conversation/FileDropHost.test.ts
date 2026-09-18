import { beforeEach, describe, expect, it } from "vitest";
import { deliverDrop } from "./FileDropHost";
import { useFileDrop } from "./fileDrop";
import { useComposerAttachments } from "./composerAttachments";
import { useComposerDrafts } from "../../store/composerDrafts";
import { useConversationsStore, type Conversation } from "../../store/conversationsStore";
import { useFlightdeckModal } from "../flightdeck/flightdeckModalStore";

const zoneEl = () => document.createElement("div");

describe("deliverDrop", () => {
  beforeEach(() => {
    useConversationsStore.setState({
      conversations: [{ id: "c1", cwd: "/repo" } as Conversation],
    });
    useFlightdeckModal.setState({ convId: null, origin: null });
    useFileDrop.setState({ over: null, focusRequest: null });
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft("c1", "");
  });

  it("a card drop attaches to that conversation and opens its reply modal", async () => {
    await deliverDrop({ convId: "c1", kind: "card", el: zoneEl() }, ["/repo/docs/spec.pdf"]);
    expect(useFlightdeckModal.getState().convId).toBe("c1");
    expect(useComposerDrafts.getState().drafts.c1).toBe("docs/spec.pdf ");
    // A mention was appended → the modal's composer is asked to put the caret after it.
    expect(useFileDrop.getState().focusRequest?.convId).toBe("c1");
  });

  it("a column drop attaches in place (no modal) and focuses the composer", async () => {
    await deliverDrop({ convId: "c1", kind: "pane", el: zoneEl() }, ["/tmp/notes.txt"]);
    expect(useFlightdeckModal.getState().convId).toBeNull();
    expect(useComposerDrafts.getState().drafts.c1).toBe("/tmp/notes.txt ");
    expect(useFileDrop.getState().focusRequest?.convId).toBe("c1");
  });

  it("does nothing for a conversation that no longer exists", async () => {
    await deliverDrop({ convId: "gone", kind: "card", el: zoneEl() }, ["/repo/a.md"]);
    expect(useFlightdeckModal.getState().convId).toBeNull();
    expect(useComposerDrafts.getState().drafts.gone).toBeUndefined();
    expect(useFileDrop.getState().focusRequest).toBeNull();
  });
});
