import { describe, it, expect, vi, afterEach } from "vitest";

// jsdom doesn't implement the Web Audio API, so this also exercises the
// "no AudioContext available" graceful-degradation path.
describe("sound", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("playComposed is a no-op (never throws) when Web Audio is unavailable", async () => {
    vi.resetModules();
    const { playComposed } = await import("./sound");
    expect(() => playComposed("flightdeck:rise")).not.toThrow();
    expect(() => playComposed("flightdeck:fall")).not.toThrow();
  });

  it("every Flight Deck sound has a unique, prefixed id and a label", async () => {
    const { COMPOSED_SOUNDS } = await import("./sound");
    const ids = COMPOSED_SOUNDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of COMPOSED_SOUNDS) {
      expect(s.id.startsWith("flightdeck:")).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
    }
    // The factory pair the prefs default to must exist.
    expect(ids).toContain("flightdeck:rise");
    expect(ids).toContain("flightdeck:fall");
  });

  it("primeAudioUnlock registers gesture listeners exactly once (idempotent)", async () => {
    vi.resetModules();
    const add = vi.spyOn(window, "addEventListener");
    const { primeAudioUnlock } = await import("./sound");
    primeAudioUnlock();
    primeAudioUnlock(); // second call must be a no-op (the `primed` guard)
    const pointer = add.mock.calls.filter((c) => c[0] === "pointerdown");
    const key = add.mock.calls.filter((c) => c[0] === "keydown");
    expect(pointer).toHaveLength(1);
    expect(key).toHaveLength(1);
  });
});

// A minimal fake AudioContext so we can assert the reliability behaviours under
// jsdom (which has no Web Audio). Two properties matter for the fix:
//   1. a SUSPENDED context is resume()d BEFORE the notes are scheduled, otherwise
//      they're silently dropped;
//   2. every play builds a FRESH context and close()s it once decayed, so a stale
//      "running but silent" context from an earlier audio-session change (the user
//      playing a video) can never carry over.
describe("sound — fresh-context-per-play reliability", () => {
  const audioParam = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

  /** A fake context whose resume() flips `state` to "running" ASYNCHRONOUSLY (on a
   *  microtask), like the real one — so scheduling before the await would see it
   *  still suspended, which is exactly the bug we guard against. close() flips it
   *  to "closed" so the module's live-context bookkeeping stays honest. */
  function makeFakeAudio(initial: "suspended" | "running") {
    const oscillators: Array<{ start: ReturnType<typeof vi.fn> }> = [];
    const gains: Array<{ gain: ReturnType<typeof audioParam> }> = [];
    const ctx = {
      state: initial as string,
      currentTime: 0,
      resume: vi.fn(function (this: { state: string }) {
        return Promise.resolve().then(() => {
          this.state = "running";
        });
      }),
      close: vi.fn(function (this: { state: string }) {
        this.state = "closed";
        return Promise.resolve();
      }),
      createGain: () => {
        const g = { gain: audioParam(), ...node() };
        gains.push(g);
        return g;
      },
      createBiquadFilter: () => ({ type: "", frequency: { value: 0 }, Q: { value: 0 }, ...node() }),
      createOscillator: () => {
        const osc = { type: "", frequency: audioParam(), start: vi.fn(), stop: vi.fn(), ...node() };
        oscillators.push(osc);
        return osc;
      },
      destination: node(),
    };
    return { ctx, oscillators, gains };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("resumes first, then lays down the notes once running", async () => {
    vi.resetModules();
    const { ctx, oscillators } = makeFakeAudio("suspended");
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      return ctx;
    };
    const { playComposed } = await import("./sound");

    playComposed("flightdeck:rise");
    expect(ctx.resume).toHaveBeenCalled();
    // Nothing scheduled yet — the context is still suspended synchronously.
    expect(oscillators).toHaveLength(0);

    // Let the resume() microtask (and the chained scheduling) settle.
    await new Promise((r) => setTimeout(r));
    expect(ctx.state).toBe("running");
    expect(oscillators.length).toBeGreaterThan(0);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalled();
  });

  it("schedules inline (no wait) when the context is already running", async () => {
    vi.resetModules();
    const { ctx, oscillators } = makeFakeAudio("running");
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      return ctx;
    };
    const { playComposed } = await import("./sound");

    playComposed("flightdeck:fall");
    // Already running → notes are laid down synchronously, no resume-gate needed.
    expect(oscillators.length).toBeGreaterThan(0);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalled();
  });

  it("builds a FRESH AudioContext for every play (never reuses a stale one)", async () => {
    vi.resetModules();
    const made: Array<ReturnType<typeof makeFakeAudio>["ctx"]> = [];
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      const { ctx } = makeFakeAudio("running");
      made.push(ctx);
      return ctx;
    };
    const { playComposed } = await import("./sound");

    playComposed("flightdeck:rise");
    playComposed("flightdeck:fall");
    playComposed("flightdeck:rise");
    // One brand-new context per play — this is what defeats the "running but
    // silent" stale-context bug after other audio has reconfigured the device.
    expect(made).toHaveLength(3);
  });

  it("closes the context once the chime has decayed (single-use lifecycle)", async () => {
    vi.resetModules();
    const { ctx } = makeFakeAudio("running");
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      return ctx;
    };
    const { playComposed } = await import("./sound");

    vi.useFakeTimers();
    playComposed("flightdeck:rise");
    // Still ringing out — the context must stay open until the tail has decayed.
    expect(ctx.close).not.toHaveBeenCalled();
    // Fast-forward well past the longest chime (~1.6s) + teardown margin.
    vi.advanceTimersByTime(5000);
    expect(ctx.close).toHaveBeenCalled();
    expect(ctx.state).toBe("closed");
  });

  it("schedules every Flight Deck sound and closes its context afterwards", async () => {
    vi.resetModules();
    const made: Array<ReturnType<typeof makeFakeAudio>> = [];
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      const fake = makeFakeAudio("running");
      made.push(fake);
      return fake.ctx;
    };
    const { COMPOSED_SOUNDS, playComposed } = await import("./sound");
    vi.useFakeTimers();
    for (const s of COMPOSED_SOUNDS) {
      expect(playComposed(s.id)).toBe(true);
      vi.advanceTimersByTime(5000); // decay + teardown, before the next (keeps under the cap)
    }
    expect(made).toHaveLength(COMPOSED_SOUNDS.length);
    for (const fake of made) {
      expect(fake.oscillators.length).toBeGreaterThan(0);
      expect(fake.ctx.close).toHaveBeenCalled();
    }
  });

  it("an unknown id plays nothing and says so", async () => {
    vi.resetModules();
    const made: unknown[] = [];
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      made.push(1);
      return makeFakeAudio("running").ctx;
    };
    const { playComposed } = await import("./sound");
    expect(playComposed("flightdeck:nope")).toBe(false);
    expect(made).toHaveLength(0);
  });

  it("the volume scales the master level", async () => {
    vi.resetModules();
    const fakes: Array<ReturnType<typeof makeFakeAudio>> = [];
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      const fake = makeFakeAudio("running");
      fakes.push(fake);
      return fake.ctx;
    };
    const { playComposed } = await import("./sound");
    playComposed("flightdeck:rise", 1);
    playComposed("flightdeck:rise", 0.5);
    // The master is the first gain node each play creates.
    const [full, half] = fakes.map((f) => f.gains[0].gain.value);
    expect(full).toBeGreaterThan(0);
    expect(half).toBeCloseTo(full / 2);
  });
});
