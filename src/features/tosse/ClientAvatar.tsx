// A client's mark on a band header — the CRM's own `ClientAvatar`, ported.
//
// Same three-step cascade, in the same order, so a client wears here exactly the mark it
// wears in the browser:
//   1. the logo uploaded in the CRM (`logoUrl`),
//   2. failing that, the favicon of its website's domain,
//   3. failing that, its initials on a colour picked from its name.
//
// Each step falls to the next when the image cannot be loaded, so a dead URL degrades to a
// readable mark instead of leaving a hole.
//
// ⚠️ Step 2 is the only thing in this app that talks to a THIRD PARTY, and it is therefore
// OPT-IN (`tosseClientFavicons`, off by default — see the preference's own doc). Resolving a
// favicon means handing `google.com` the client's domain and this machine's IP, once per
// client on screen: a slice of Tosse's client list, leaving the building. The CRM's web page
// already does it, so this is parity, not a new exposure — but parity is a reason to OFFER
// the step, not to take it silently on everyone's behalf. Off, the cascade is 1 → 3, entirely
// local, and that is what most clients render anyway.

import { useEffect, useMemo, useState } from "react";
import { useDisplay } from "../../store/display";
import s from "./TosseView.module.css";

/** Mailbox providers: their favicon says nothing about the client, so the CRM skips them
 *  rather than stamping half its list with the same Gmail icon. Ported verbatim. */
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.fr",
  "outlook.com", "outlook.fr", "yahoo.com", "yahoo.fr",
  "free.fr", "orange.fr", "sfr.fr", "laposte.net",
  "wanadoo.fr", "live.com", "live.fr", "msn.com",
  "icloud.com", "me.com", "protonmail.com", "proton.me",
  "aol.com", "mail.com", "yandex.com", "zoho.com",
]);

/** The CRM's six avatar gradients, as flat pairs. Picked by a hash of the name, so a client
 *  keeps the same colour across sessions and across both apps. */
const GRADIENTS: Array<[string, string]> = [
  ["#8b5cf6", "#9333ea"],
  ["#3b82f6", "#06b6d4"],
  ["#10b981", "#0d9488"],
  ["#f97316", "#f59e0b"],
  ["#f43f5e", "#db2777"],
  ["#6366f1", "#2563eb"],
];

/** The CRM's string hash, kept identical so the colour matches the one in the browser. */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * The favicon URL for a domain, or null when the step is switched off / has nothing to work
 * with. Pure, so the opt-in and the escaping are both testable.
 *
 * `encodeURIComponent` is not defensive theatre: the domain comes from a CRM free-text
 * `website` field via `URL.hostname`, and the day that source widens (an IDN, a stray `&`),
 * an unescaped value would silently rewrite this request's query string.
 */
export function faviconUrl(domain: string | null, enabled: boolean): string | null {
  if (!enabled || !domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** The domain a favicon can be fetched for, or null when there is nothing usable. */
export function faviconDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`);
    const domain = u.hostname.replace(/^www\./, "");
    if (!domain || GENERIC_DOMAINS.has(domain)) return null;
    return domain;
  } catch {
    return null;
  }
}

/** Two letters, from two words when there are two. Never empty — "?" beats a blank plate. */
export function clientInitials(name: string): string {
  const letters = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return letters || "?";
}

export function ClientAvatar({
  name,
  logoUrl,
  website,
}: {
  name: string;
  logoUrl?: string | null;
  website?: string | null;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  // Opt-in for step 2 — see the file header. Subscribed, so flipping it in Settings
  // re-renders the marks instead of waiting for the next mount.
  const faviconsAllowed = useDisplay((d) => d.tosseClientFavicons);
  const domain = useMemo(() => faviconDomain(website), [website]);
  const favicon = faviconUrl(domain, faviconsAllowed);

  // A different client in the same slot must not inherit the previous one's failures.
  useEffect(() => {
    setLogoFailed(false);
    setFaviconFailed(false);
  }, [logoUrl, domain]);

  const src = !logoFailed && logoUrl ? logoUrl : !faviconFailed ? favicon : null;

  if (src) {
    return (
      <span className={s.bandLogo}>
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => (logoFailed || !logoUrl ? setFaviconFailed(true) : setLogoFailed(true))}
        />
      </span>
    );
  }

  const [from, to] = GRADIENTS[hashString(name) % GRADIENTS.length];
  return (
    <span
      className={s.bandAvatar}
      style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {clientInitials(name)}
    </span>
  );
}
