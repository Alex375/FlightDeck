// The assignee mark has to match the CRM's exactly — same initials, same split of the
// "MCP de <name>" attribution. These are hard-coded correspondences, not derivations, so a
// test is the only thing keeping them from drifting apart from `PersonAvatar`.

import { describe, expect, it } from "vitest";
import { assigneeInitials, splitMcpActor } from "./AssigneeAvatar";
import { clientInitials, faviconDomain, faviconUrl, hashString } from "./ClientAvatar";

describe("assignee initials", () => {
  // Verbatim from CRM_max/apps/frontend/components/shared/person-avatar.tsx.
  it("uses the CRM's own initials, which are NOT the name's first letters", () => {
    expect(assigneeInitials("Alexandre")).toBe("JO");
    expect(assigneeInitials("Armand")).toBe("C8");
    expect(assigneeInitials("Les deux")).toBe("2");
  });

  it("falls back to two upper-case letters for anyone else", () => {
    expect(assigneeInitials("Camille")).toBe("CA");
  });
});

describe("MCP attribution", () => {
  it("splits « MCP de X » into the person and a flag", () => {
    expect(splitMcpActor("MCP de Alexandre")).toEqual({ person: "Alexandre", viaMcp: true });
    // …and the person still gets THEIR mark inside the badge.
    expect(assigneeInitials(splitMcpActor("MCP de Armand").person)).toBe("C8");
  });

  it("leaves an ordinary assignee alone", () => {
    expect(splitMcpActor("Armand")).toEqual({ person: "Armand", viaMcp: false });
    // "MCP" on its own is not an attribution prefix.
    expect(splitMcpActor("MCP")).toEqual({ person: "MCP", viaMcp: false });
  });
});

describe("client avatar", () => {
  it("skips mailbox providers, whose favicon says nothing about the client", () => {
    expect(faviconDomain("https://gmail.com")).toBeNull();
    expect(faviconDomain("https://www.free.fr")).toBeNull();
  });

  it("takes the bare domain, with or without a scheme", () => {
    expect(faviconDomain("https://www.webdentiste.fr/contact")).toBe("webdentiste.fr");
    expect(faviconDomain("webdentiste.fr")).toBe("webdentiste.fr");
  });

  it("returns null rather than throwing on junk", () => {
    expect(faviconDomain("not a url at all !!")).toBeNull();
    expect(faviconDomain(null)).toBeNull();
    expect(faviconDomain("")).toBeNull();
  });

  it("never renders an empty plate", () => {
    expect(clientInitials("Webdentiste")).toBe("W");
    expect(clientInitials("Jean Dupont")).toBe("JD");
    expect(clientInitials("")).toBe("?");
  });

  // ⚠️ The one call in this app that leaves the machine. Off, nothing is requested at all —
  // not a blocked image, not a request Google could log: the URL is never built.
  it("asks Google for a favicon ONLY when the preference is on", () => {
    expect(faviconUrl("webdentiste.fr", false)).toBeNull();
    expect(faviconUrl("webdentiste.fr", true)).toBe(
      "https://www.google.com/s2/favicons?domain=webdentiste.fr&sz=128",
    );
    // Nothing to ask about is still nothing, whatever the preference says.
    expect(faviconUrl(null, true)).toBeNull();
  });

  it("escapes the domain it puts in the query string", () => {
    // `website` is CRM free text; an unescaped value would rewrite the query rather than
    // travel in it.
    expect(faviconUrl("evil.example&sz=1", true)).toBe(
      "https://www.google.com/s2/favicons?domain=evil.example%26sz%3D1&sz=128",
    );
  });

  it("gives a client a STABLE colour (the hash is the CRM's)", () => {
    // Same name → same bucket, every launch and in both apps.
    expect(hashString("Webdentiste")).toBe(hashString("Webdentiste"));
    expect(hashString("Interne")).not.toBe(hashString("Webdentiste"));
  });
});
