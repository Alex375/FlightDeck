import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({ commands: { takeFolderRoutingReport: vi.fn() } }));

import { commands, type FolderRoutingReport } from "../ipc/client";
import { useAppErrors } from "./appErrors";
import { useToasts } from "./toasts";
import { announceFolderRoutingRepair, folderRoutingAnnouncement } from "./folderRouting";

const report = (over: Partial<FolderRoutingReport> = {}): FolderRoutingReport => ({
  moved: [],
  unresolved: [],
  error: null,
  ...over,
});
const moved = (name: string, to: string | null) => ({
  conversation_id: name,
  conversation_name: name,
  to_machine: to,
});

describe("folderRoutingAnnouncement", () => {
  it("says nothing when the repair had nothing to do (or already ran)", () => {
    expect(folderRoutingAnnouncement(null)).toEqual({ info: null, warning: null });
    expect(folderRoutingAnnouncement(report())).toEqual({ info: null, warning: null });
  });

  it("names what was moved and where", () => {
    expect(folderRoutingAnnouncement(report({ moved: [moved("Fix login", "build-box")] })).info).toBe(
      '1 conversation was moved to the folder on server build-box — an earlier version ran it there: "Fix login".',
    );
    const home = folderRoutingAnnouncement(report({ moved: [moved("A", null), moved("B", null)] })).info;
    expect(home).toMatch(/^2 conversations were moved to this Mac's folder at the same path/);
    const mixed = folderRoutingAnnouncement(
      report({ moved: [moved("A", null), moved("B", "x"), moved("C", "x"), moved("D", "x")] }),
    ).info;
    expect(mixed).toMatch(/the folders of the machines they ran on/);
    expect(mixed).toMatch(/"A", "B", "C" and 1 more\.$/);
  });

  it("keeps what could not be settled on screen, with each reason", () => {
    const { warning } = folderRoutingAnnouncement(
      report({
        unresolved: [{ conversation_id: "c", conversation_name: "Deploy", reason: "shared by several servers" }],
        error: "Couldn't read this Mac's Claude transcripts",
      }),
    );
    expect(warning?.message).toBe("1 conversation may be filed under the wrong machine's folder");
    expect(warning?.detail).toBe('"Deploy": shared by several servers.\nCouldn\'t read this Mac\'s Claude transcripts');
  });

  it("an unreadable transcript store alone is still a warning", () => {
    expect(folderRoutingAnnouncement(report({ error: "denied" })).warning?.message).toMatch(/Couldn't finish checking/);
  });
});

describe("announceFolderRoutingRepair", () => {
  it("toasts the moves and raises the unresolved", async () => {
    useToasts.setState({ toasts: [] });
    useAppErrors.setState({ errors: [] });
    vi.mocked(commands.takeFolderRoutingReport).mockResolvedValueOnce(
      report({
        moved: [moved("A", "x")],
        unresolved: [{ conversation_id: "c", conversation_name: "B", reason: "r" }],
      }),
    );
    await announceFolderRoutingRepair();
    // Sticky: the moves are permanent and happen once — they must not fade unseen.
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ kind: "info", sticky: true })]);
    expect(JSON.stringify(useAppErrors.getState())).toContain("may be filed under the wrong machine");
  });

  it("says so when the report cannot even be fetched", async () => {
    useAppErrors.setState({ errors: [] });
    vi.mocked(commands.takeFolderRoutingReport).mockRejectedValueOnce(new Error("ipc down"));
    await announceFolderRoutingRepair();
    expect(JSON.stringify(useAppErrors.getState())).toContain("ipc down");
  });
});
