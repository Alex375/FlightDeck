import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS,
  foldLinkEvent,
  linkEventLines,
  linkEventOf,
  linkRunDetail,
  linkRunOf,
  linkRunText,
  type LinkEvent,
  type LinkRun,
} from "./linkNotices";

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 17, h, m, s).getTime();
const lost = (atMs: number, over: Partial<LinkEvent> = {}): LinkEvent => ({
  link: "lost",
  atMs,
  message: "Connection to the server lost — reconnecting…",
  attachedBefore: true,
  ...over,
});
const restored = (atMs: number): LinkEvent => ({ link: "restored", atMs, message: "Reconnected to the server." });
const fold = (events: LinkEvent[]): LinkRun =>
  events.reduce<LinkRun | null>((run, ev) => foldLinkEvent(run, ev), null)!;

describe("linkEventOf", () => {
  it("reads only the core's tagged lifecycle notices", () => {
    expect(
      linkEventOf("remote_link", { message: "x", link: "lost", at_ms: 5, attached_before: false, hint: null }),
    ).toEqual({ link: "lost", atMs: 5, message: "x", cause: null, hint: null, address: null, attachedBefore: false });
    // A takeover, a message to resend, a restarted server: each stays its own line.
    expect(linkEventOf("remote_link", { message: "Another client took over this remote session." })).toBeNull();
    expect(linkEventOf("process_exited", { message: "x", link: "lost" })).toBeNull();
  });
});

describe("foldLinkEvent / linkRunText", () => {
  it("says one drop, then that it came back and after how long", () => {
    const down = fold([lost(at(10, 2))]);
    expect(linkRunText(down)).toBe("Connection to the server lost at 10:02.");
    expect(linkRunText(fold([lost(at(10, 2)), restored(at(10, 2, 12))]))).toBe(
      "Connection to the server lost at 10:02 — back after 12 s.",
    );
  });

  it("folds a flapping link into ONE line: how many drops, when, and that it came back", () => {
    const run = fold([
      lost(at(10, 2)),
      restored(at(10, 3)),
      lost(at(10, 7)),
      restored(at(10, 7, 20)),
      lost(at(10, 15)),
      restored(at(10, 15, 5)),
    ]);
    expect(run.drops).toBe(3);
    expect(linkRunText(run)).toBe("Connection to the server dropped 3 times between 10:02 and 10:15, and came back each time.");
  });

  it("says a run that ends down is down, since when", () => {
    const run = fold([lost(at(10, 2)), restored(at(10, 3)), lost(at(10, 9), { hint: "Tailscale looks off on this Mac." })]);
    expect(linkRunText(run)).toBe(
      "Connection to the server dropped 2 times since 10:02 — down again at 10:09. Tailscale looks off on this Mac.",
    );
  });

  it("takes the reason a later retry names into the drop it belongs to, without counting a new drop", () => {
    // The core's contract (`run_actor`): an attached link that closes names no cause; the
    // first retry that fails on one ssh can name adds another "lost" notice carrying it.
    const said = "ssh: Cannot execute command-line and remote command.";
    const run = fold([lost(at(10, 2)), lost(at(10, 2, 1), { hint: said })]);
    expect(run.drops).toBe(1);
    expect(run.hint).toBe(said);
    expect(linkRunText(run)).toBe(`Connection to the server lost at 10:02. ${said}`);
  });

  it("counts a stall and the close that follows it as the one drop they are", () => {
    const run = fold([lost(at(10, 2), { cause: "stalled" }), lost(at(10, 2, 1)), restored(at(10, 2, 30))]);
    expect(run.drops).toBe(1);
    expect(linkRunText(run)).toBe("Connection to the server lost at 10:02 — back after 30 s.");
  });

  it("never says 'lost' for a first dial that never attached", () => {
    const failing = fold([lost(at(9, 0), { attachedBefore: false })]);
    expect(linkRunText(failing)).toBe("Couldn't connect to the server at 09:00.");
    expect(linkRunText(fold([lost(at(9, 0), { attachedBefore: false }), restored(at(9, 0, 40))]))).toBe(
      "Connected to the server at 09:00, after 40 s of failed attempts.",
    );
  });

  it("folds an address rotation into the drop it belongs to", () => {
    const run = fold([lost(at(10, 2)), { link: "address", atMs: at(10, 2, 9), message: "x", address: "100.64.0.2" }]);
    expect(run.drops).toBe(1);
    expect(linkRunText(run)).toBe("Connection to the server lost at 10:02.");
    expect(linkEventLines(run)).toEqual(["10:02:00 — connection lost", "10:02:09 — trying another address: 100.64.0.2"]);
  });

  it("keeps a run opened by anything but a drop readable", () => {
    expect(linkRunText(fold([restored(at(10, 2))]))).toBe("Reconnected to the server.");
  });

  it("bounds the events a run keeps, and says how many it let go", () => {
    const events: LinkEvent[] = [];
    for (let i = 0; i < 40; i++) events.push(i % 2 ? restored(at(10, i)) : lost(at(10, i)));
    const run = fold(events);
    expect(run.drops).toBe(20);
    expect(run.events).toHaveLength(MAX_EVENTS);
    expect(linkEventLines(run)[0]).toBe("… 10 earlier");
  });
});

describe("linkRunDetail", () => {
  it("stores the run under its line, so the thread and read_conversation read the summary", () => {
    const detail = linkRunDetail(fold([lost(at(10, 2)), restored(at(10, 2, 12))]));
    expect(detail).toMatchObject({ message: "Connection to the server lost at 10:02 — back after 12 s.", link: "restored" });
    expect(linkRunOf("remote_link", detail)?.drops).toBe(1);
    expect(linkRunOf("remote_link", { message: "x" })).toBeNull();
  });
});
