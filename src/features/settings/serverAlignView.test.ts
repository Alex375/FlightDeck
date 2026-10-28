import { describe, expect, it } from "vitest";
import type { AlignPart, AlignReport, MachineAlignState } from "../../ipc/client";
import { alignHeadline, alignLines } from "./serverAlignView";

const part = (status: AlignPart["status"], before: string | null = null, after: string | null = null, detail: string | null = null): AlignPart => ({
  status,
  before,
  after,
  detail,
});

function report(over: Partial<AlignReport> = {}): AlignReport {
  return {
    machine_id: "m",
    trigger: "connect",
    claude: part("current", "2.1.312", "2.1.312"),
    daemon: part("current", "0.7.0", "0.7.0"),
    config: part("current"),
    config_changes: { written: 0, removed: 0, mcp_set: 0, mcp_removed: 0, mcp_withheld: [], backup: null },
    sessions: part("current"),
    mac_claude_version: "2.1.312",
    server_claude_version: "2.1.312",
    ok: true,
    finished_at: Date.UTC(2026, 9, 28, 14, 0),
    ...over,
  };
}

const state = (over: Partial<MachineAlignState> = {}): MachineAlignState => ({
  machine_id: "m",
  keep_aligned: true,
  running: false,
  last: null,
  last_error: null,
  ...over,
});

describe("alignLines", () => {
  it("gives every part its line, versions moved and the backend's words kept", () => {
    const lines = alignLines(
      report({
        claude: part("updated", "2.1.278", "2.1.312"),
        config: part("updated", null, null, "3 files written"),
        daemon: part("deferred", "0.6.0", "0.6.0", "flightdeckd 0.7.0 is on the server; it restarts once no conversation works"),
        sessions: part("failed", null, null, "couldn't restart the conversations at rest: boom"),
      }),
    );
    expect(lines.map((l) => [l.label, l.tone])).toEqual([
      ["Claude Code", "ready"],
      ["Config", "ready"],
      ["Daemon", "caution"],
      ["Conversations", "error"],
    ]);
    expect(lines[0].text).toBe("Updated · 2.1.278 → 2.1.312");
    expect(lines[1].text).toBe("Copied from this Mac — 3 files written");
    expect(lines[2].text).toContain("Waiting · 0.6.0 — flightdeckd 0.7.0 is on the server");
    expect(lines[3].text).toBe("Failed — couldn't restart the conversations at rest: boom");
  });
});

describe("alignHeadline", () => {
  it("says what the last pass found, worst part first", () => {
    expect(alignHeadline(undefined).tone).toBe("muted");
    expect(alignHeadline(state({ running: true })).text).toMatch(/Syncing/);
    expect(alignHeadline(state()).text).toMatch(/Not synced/);
    expect(alignHeadline(state({ keep_aligned: false })).text).toMatch(/off/);
    expect(alignHeadline(state({ last_error: "couldn't sync with this server — could not reach the server" }))).toEqual({
      tone: "error",
      text: "couldn't sync with this server — could not reach the server",
    });
    expect(alignHeadline(state({ last: report() })).tone).toBe("ready");
    expect(alignHeadline(state({ last: report({ daemon: part("deferred") }) })).tone).toBe("caution");
    expect(alignHeadline(state({ last: report({ config: part("failed") }) })).tone).toBe("error");
  });
});
