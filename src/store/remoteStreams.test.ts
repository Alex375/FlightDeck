import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteConversationState } from "../ipc/client";
import {
  clearAllRemoteStreams,
  forgetRemoteStream,
  markRemoteStream,
  markRemoteStreamReplaced,
  planRemoteResume,
  remoteStreamMarks,
  type ResumeCandidate,
} from "./remoteStreams";

const state = (over: Partial<RemoteConversationState> = {}): RemoteConversationState => ({
  conversation_id: "c",
  running: true,
  busy: false,
  pending: 0,
  background_tasks: 0,
  at_work: false,
  ...over,
});

const candidate = (over: Partial<ResumeCandidate>): ResumeCandidate => ({
  convId: "c",
  mark: undefined,
  state: undefined,
  reminder: null,
  ...over,
});

describe("planRemoteResume", () => {
  it("re-attaches a conversation at work on its server, mark or not", () => {
    const plan = planRemoteResume([
      candidate({ convId: "busy", state: state({ busy: true, at_work: true }) }),
      candidate({ convId: "asking", state: state({ pending: 1, at_work: true }), mark: { atWork: true } }),
      candidate({ convId: "background", state: state({ background_tasks: 2, at_work: true }) }),
    ]);
    expect(plan).toEqual({ attach: ["busy", "asking", "background"], review: [], ended: [], forget: [] });
  });

  it("puts a stream that was on back on, and marks a turn that finished meanwhile for review", () => {
    const plan = planRemoteResume([
      candidate({ convId: "idle-on", state: state(), mark: { atWork: false } }),
      candidate({ convId: "finished", state: state(), mark: { atWork: true } }),
    ]);
    expect(plan).toEqual({ attach: ["idle-on", "finished"], review: ["finished"], ended: [], forget: [] });
  });

  it("never attaches a conversation with no live process (an attach would cold-start one)", () => {
    const plan = planRemoteResume([
      candidate({ convId: "stopped", state: state({ running: false }), mark: { atWork: false } }),
      candidate({ convId: "gone", state: undefined, mark: { atWork: true } }),
      candidate({ convId: "never-on", state: undefined }),
      candidate({ convId: "idle-off", state: state() }),
    ]);
    expect(plan).toEqual({ attach: [], review: [], ended: ["gone"], forget: ["stopped", "gone"] });
  });

  it("a conversation at work whose process is gone ended abnormally, it did not finish", () => {
    // A persistent claude does not exit after a turn: gone while at work = killed (a crash, a
    // server or daemon restart, a stop from another device), not a turn that finished.
    const plan = planRemoteResume([
      candidate({ convId: "gone", state: undefined, mark: { atWork: true } }),
      candidate({ convId: "dead", state: state({ running: false }), mark: { atWork: true } }),
    ]);
    expect(plan).toEqual({ attach: [], review: [], ended: ["gone", "dead"], forget: ["gone", "dead"] });
  });

  it("an existing reminder is kept over an abnormal end too", () => {
    const plan = planRemoteResume([candidate({ convId: "c", state: undefined, mark: { atWork: true }, reminder: "openQuestion" })]);
    expect(plan).toEqual({ attach: [], review: [], ended: [], forget: ["c"] });
  });

  it("keeps an existing reminder (an error, an open question) instead of calling it review", () => {
    const plan = planRemoteResume([candidate({ convId: "c", state: state(), mark: { atWork: true }, reminder: "error" })]);
    expect(plan).toEqual({ attach: ["c"], review: [], ended: [], forget: [] });
  });

  it("leaves a conversation another client took over alone, even at work, until its process is gone", () => {
    const replaced = { atWork: false, replaced: true as const };
    const plan = planRemoteResume([
      candidate({ convId: "held", state: state({ busy: true, at_work: true }), mark: replaced }),
      candidate({ convId: "released", state: undefined, mark: replaced }),
    ]);
    expect(plan).toEqual({ attach: [], review: [], ended: [], forget: ["released"] });
  });

  it("a conversation still at work is not 'finished'", () => {
    const plan = planRemoteResume([
      candidate({ convId: "c", state: state({ busy: true, at_work: true }), mark: { atWork: true } }),
    ]);
    expect(plan.review).toEqual([]);
  });
});

describe("the persisted marks", () => {
  beforeEach(() => clearAllRemoteStreams());

  it("survive a reload, change only when the value does, and go when forgotten", () => {
    markRemoteStream("a", true);
    markRemoteStream("b", false);
    markRemoteStream("a", false);
    expect(remoteStreamMarks()).toEqual({ a: { atWork: false }, b: { atWork: false } });
    forgetRemoteStream("a");
    expect(remoteStreamMarks()).toEqual({ b: { atWork: false } });
    clearAllRemoteStreams();
    expect(remoteStreamMarks()).toEqual({});
  });

  it("a take-over tombstone holds until the stream is on again here", () => {
    markRemoteStream("a", true);
    markRemoteStreamReplaced("a");
    expect(remoteStreamMarks()).toEqual({ a: { atWork: false, replaced: true } });
    markRemoteStream("a", false); // the user turned it on again on this Mac
    expect(remoteStreamMarks()).toEqual({ a: { atWork: false } });
  });

  it("a corrupt entry is ignored, never thrown on", () => {
    localStorage.setItem("tosse:remotestreams", JSON.stringify({ ok: { atWork: true }, bad: { atWork: "yes" }, worse: 3 }));
    expect(remoteStreamMarks()).toEqual({ ok: { atWork: true } });
    localStorage.setItem("tosse:remotestreams", "{not json");
    expect(remoteStreamMarks()).toEqual({});
  });
});
