import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildServerCommand, parseTicket } from "./ControlSection";

// Regression test for the "pairing ticket never printed" bug: a serial paste target
// that submits each line on its own Enter can leave an unterminated quote/subshell
// open across a REAL newline in the script, silently swallowing everything after it.
// The command must be genuinely ONE line — only literal `\n` two-character sequences
// inside printf format strings (which printf itself turns into real newlines in its
// OWN output), never a real newline in the script's own source text.
describe("buildServerCommand", () => {
  it("renders as a single line — zero real newline characters", () => {
    const cmd = buildServerCommand("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 flightdeck-server");
    expect(cmd).not.toContain("\n");
  });

  it("still contains literal backslash-n sequences for printf's own escaping", () => {
    const cmd = buildServerCommand("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 flightdeck-server");
    // These must survive as the two characters `\` + `n`, not collapse into a real
    // newline — e.g. inside `printf "%s\n" "..."`.
    expect(cmd).toContain('printf "%s\\n"');
    expect(cmd.split("\\n").length).toBeGreaterThan(1);
  });

  it("embeds the public key and notes flightdeckd presence like the existing claude check", () => {
    const cmd = buildServerCommand("ssh-ed25519 AAAA my-key");
    expect(cmd).toContain("ssh-ed25519 AAAA my-key");
    expect(cmd).toContain("command -v claude");
    expect(cmd).toContain("command -v flightdeckd");
    // The ticket must still print even when flightdeckd is missing — it's a NOTE
    // (`||`), never a hard stop for the script.
    expect(cmd).toMatch(/command -v flightdeckd >\/dev\/null 2>&1 \|\| printf/);
  });

  it("statements are joined with '; ' so a serial paste target survives", () => {
    const cmd = buildServerCommand("key");
    expect(cmd).toContain("; ");
  });
});

// Regression test for the Tailscale discovery pattern being dead code against a real
// `tailscale status --json`: Go's `json.MarshalIndent` puts a SPACE after the colon
// (`"DNSName": "…"`), but the pattern required none. Runs the ACTUAL pipeline
// `buildServerCommand` emits (not a hand-copied approximation) through a real POSIX
// shell against captured real and compact JSON shapes, so a future edit to the regex
// can't silently regress untested again.
describe("buildServerCommand — Tailscale address discovery pipeline", () => {
  /** Pulls the `grep | head | cut | sed` pipeline out of the `TS_H=$(…); fi`
   *  statement `buildServerCommand` emits, so the test runs the SAME text the real
   *  pairing command does rather than a copy that could drift from it. Matched
   *  against the whole joined command (not split on `"; "` first) because the
   *  statement itself contains internal `;` — e.g. `if …; then …; fi` — which a
   *  naive split on the array-join separator would also cut through. */
  function extractTailscalePipeline(cmd: string): string {
    const match = cmd.match(/then TS_H=\$\(([^)]*)\); fi/);
    if (!match) throw new Error(`could not isolate the tailscale pipeline from: ${cmd}`);
    return match[1];
  }

  /** Runs the extracted pipeline in a real `/bin/sh`, with `tailscale` stubbed as a
   *  shell function that prints fixture JSON — so `grep`/`cut`/`sed` run unmodified
   *  against it, exactly as they would against the real binary's output. */
  function runTailscalePipeline(pipeline: string, fakeJson: string): string {
    const quotedJson = fakeJson.replace(/'/g, `'\\''`);
    const script = `tailscale() { printf '%s' '${quotedJson}'; }\nTS_H=$(${pipeline})\nprintf '%s' "$TS_H"`;
    return execSync(script, { shell: "/bin/sh", encoding: "utf8" });
  }

  const pipeline = extractTailscalePipeline(buildServerCommand("ssh-ed25519 AAAA test"));

  it("extracts DNSName from real `tailscale status --json` output (space after the colon)", () => {
    // Shape captured from a real `tailscale status --json` (1.102.4): Self prints
    // before Peer, and MarshalIndent puts a space after every key's colon.
    const real =
      '{\n\t"Version": "1.102.4",\n\t"Self": {\n\t\t"DNSName": "macbook-air-de-armand.tail640409.ts.net.",\n\t\t"Online": true\n\t},\n\t"Peer": {}\n}';
    expect(runTailscalePipeline(pipeline, real)).toBe("macbook-air-de-armand.tail640409.ts.net");
  });

  it("also tolerates compact JSON with no space after the colon (the old, narrower shape)", () => {
    const compact = '{"Self":{"DNSName":"compact-host.ts.net."}}';
    expect(runTailscalePipeline(pipeline, compact)).toBe("compact-host.ts.net");
  });
});

describe("parseTicket", () => {
  function ticket(payload: unknown): string {
    return `fdpair:${btoa(JSON.stringify(payload))}`;
  }

  it("parses a ticket WITH addresses into the multi-candidate shape", () => {
    const raw = ticket({
      label: "my-vps",
      host: "192.168.1.5",
      port: 22,
      user: "root",
      addresses: [
        { kind: "tailscale", value: "my-vps.tailnet.ts.net" },
        { kind: "lan", value: "192.168.1.5" },
      ],
    });
    const t = parseTicket(raw);
    expect(t).not.toBeNull();
    expect(t?.label).toBe("my-vps");
    expect(t?.host).toBe("192.168.1.5");
    expect(t?.addresses).toEqual([
      { kind: "tailscale", value: "my-vps.tailnet.ts.net" },
      { kind: "lan", value: "192.168.1.5" },
    ]);
  });

  it("synthesizes a single manual candidate from host for an old ticket WITHOUT addresses", () => {
    const raw = ticket({ label: "old-box", host: "10.0.0.9", port: 22, user: "deploy" });
    const t = parseTicket(raw);
    expect(t).not.toBeNull();
    expect(t?.addresses).toEqual([{ kind: "manual", value: "10.0.0.9" }]);
  });

  it("does not crash on a malformed addresses field, and still returns a usable candidate", () => {
    const raw = ticket({ label: "weird", host: "10.0.0.1", port: 22, user: "u", addresses: "not-an-array" });
    const t = parseTicket(raw);
    expect(t).not.toBeNull();
    expect(t?.addresses).toEqual([{ kind: "manual", value: "10.0.0.1" }]);
  });

  it("drops malformed entries inside an addresses array without crashing", () => {
    const raw = ticket({
      label: "mixed",
      host: "10.0.0.1",
      port: 22,
      user: "u",
      addresses: [null, 42, { kind: "lan", value: "10.0.0.1" }, { kind: "bogus-kind", value: "x" }],
    });
    const t = parseTicket(raw);
    expect(t).not.toBeNull();
    expect(t?.addresses).toEqual([
      { kind: "lan", value: "10.0.0.1" },
      { kind: "manual", value: "x" },
    ]);
  });

  it("returns null for garbage input, as before", () => {
    expect(parseTicket("not a ticket at all")).toBeNull();
  });
});
