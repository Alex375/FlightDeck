import { describe, it, expect } from "vitest";
import type { AlertSoundLibrary } from "../../ipc/client";
import { fallbackLabel, soundPresence } from "./NotificationSounds";

const library: AlertSoundLibrary = {
  groups: [
    { id: "system", label: "macOS alerts", sounds: [{ id: "system:Glass.aiff", label: "Glass" }] },
    { id: "tones", label: "macOS tones", sounds: [{ id: "tones:Modern/Chord.m4r", label: "Chord" }] },
  ],
  user_dir: "/Users/me/Library/Sounds",
  unavailable: null,
};

describe("soundPresence", () => {
  it("a Flight Deck sound and 'none' are always listed", () => {
    expect(soundPresence("flightdeck:rise", undefined)).toBe("listed");
    expect(soundPresence("none", undefined)).toBe("listed");
  });

  it("an unknown Flight Deck id is missing (it plays the factory chime)", () => {
    expect(soundPresence("flightdeck:renamed", library)).toBe("missing");
  });

  it("a file is unknown until the library loads, then listed or missing", () => {
    expect(soundPresence("system:Glass.aiff", undefined)).toBe("unknown");
    expect(soundPresence("system:Glass.aiff", library)).toBe("listed");
    expect(soundPresence("tones:Modern/Chord.m4r", library)).toBe("listed");
    expect(soundPresence("user:Gone.wav", library)).toBe("missing");
  });
});

describe("fallbackLabel", () => {
  it("names a sound by its file, without folder or extension", () => {
    expect(fallbackLabel("user:Gone.wav")).toBe("Gone");
    expect(fallbackLabel("tones:Modern/Chord.m4r")).toBe("Chord");
    expect(fallbackLabel("user:my.ding.mp3")).toBe("my.ding");
    expect(fallbackLabel("flightdeck:renamed")).toBe("renamed");
  });
});
