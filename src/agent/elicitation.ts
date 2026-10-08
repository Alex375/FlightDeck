// MCP elicitation — the PURE, framework-free half.
//
// An MCP server can stop in the middle of a tool call to ask the USER for something:
// a few fields to fill in (form mode, described by a flat JSON Schema) or a page to
// open in the browser (URL mode — a sign-in, a payment, an API key the server must
// never see go through the client). The CLI forwards it as a `control_request
// {subtype:"elicitation"}`; the Rust session surfaces it on the permission channel
// under the reserved tool name below, its details in `input` (see
// `control::ElicitationReq::ui_input`), and the answer goes back through
// `answer_permission`: allow + an object of values = accept with that content, allow
// alone = bare accept, deny = decline.
//
// Kept React-free so the card, the Flight Deck state block, the attention surfaces
// and the app-control executor share one reading of the request, and so the schema
// parsing / validation / coercion is unit-testable on its own.

import type { JsonValue, PermissionRequestPayload } from "../ipc/client";

/** The tool name an elicitation is surfaced under. Mirrors the Rust
 *  `control::ELICITATION_TOOL_NAME` — never a real tool's name. */
export const ELICITATION_TOOL = "McpElicitation";

/** Is this pending request an MCP elicitation rather than a tool permission? */
export function isElicitation(req: Pick<PermissionRequestPayload, "tool_name"> | null | undefined): boolean {
  return req?.tool_name === ELICITATION_TOOL;
}

export interface FieldOption {
  value: string;
  label: string;
}

interface FieldBase {
  /** The property name — the key of the value in the answer's content. */
  key: string;
  /** Human label: the schema's `title`, else the key. */
  label: string;
  description?: string;
  required: boolean;
}

export type ElicitField =
  | (FieldBase & {
      kind: "text";
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      default?: string;
    })
  | (FieldBase & { kind: "number"; integer: boolean; minimum?: number; maximum?: number; default?: number })
  | (FieldBase & { kind: "boolean"; default?: boolean })
  | (FieldBase & { kind: "select"; options: FieldOption[]; default?: string })
  | (FieldBase & {
      kind: "multiselect";
      options: FieldOption[];
      minItems?: number;
      maxItems?: number;
      default?: string[];
    });

export interface Elicitation {
  /** Who asks: the server's display label, else its configured name. */
  server: string;
  message: string;
  mode: "form" | "url";
  /** URL mode: the raw url as the server sent it (shown even when unsafe to open). */
  url: string | null;
  /** URL mode: the url when it is an http(s) link we may hand to the browser, else null. */
  openableUrl: string | null;
  /** URL mode: the host the link points to — what the user must check before opening. */
  urlHost: string | null;
  /** Form mode: the fields to collect, in the schema's order. Empty = a plain confirm. */
  fields: ElicitField[];
  /** Schema properties this form cannot render. A REQUIRED one makes the form
   *  impossible to submit honestly — the card says so and only offers Decline.
   *  Forward-compat only today: claude 2.1.293 validates the schema against the MCP
   *  field types itself and rejects anything else (-32602 to the server) before the
   *  request ever reaches us. */
  unsupported: { key: string; label: string; required: boolean }[];
}

/** A field's value while the user edits it: text-like fields hold their raw string
 *  (a number is parsed only on submit, so a half-typed "-" is not lost). */
export type FieldValue = string | boolean | string[];

function asObject(v: JsonValue | undefined): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** `[{const, title}]` (the titled enum form) or a plain `enum` (+ legacy `enumNames`)
 *  → options. `undefined` when the property carries neither. */
function optionsOf(p: Record<string, JsonValue>): FieldOption[] | undefined {
  const titled = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : undefined;
  if (titled) {
    const opts = titled
      .map((o) => asObject(o))
      .filter((o) => typeof o.const === "string")
      .map((o) => ({ value: o.const as string, label: str(o.title) ?? (o.const as string) }));
    if (opts.length) return opts;
  }
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    const opts = p.enum
      .filter((v): v is string => typeof v === "string")
      .map((v, i) => ({ value: v, label: str(names[i]) ?? v }));
    if (opts.length) return opts;
  }
  return undefined;
}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** One schema property → a renderable field, or null when its shape is not one the
 *  MCP elicitation spec allows (nested objects, free arrays…). */
function parseField(key: string, raw: JsonValue, required: boolean): ElicitField | null {
  const p = asObject(raw);
  const base: FieldBase = {
    key,
    label: str(p.title) ?? key,
    description: str(p.description),
    required,
  };
  const type = typeof p.type === "string" ? p.type : undefined;
  if (type === "array") {
    const options = optionsOf(asObject(p.items));
    if (!options) return null;
    const def = Array.isArray(p.default) ? p.default.filter((v): v is string => typeof v === "string") : undefined;
    return {
      ...base,
      kind: "multiselect",
      options,
      minItems: num(p.minItems),
      maxItems: num(p.maxItems),
      default: def,
    };
  }
  if (type === "string" || (type === undefined && optionsOf(p))) {
    const options = optionsOf(p);
    if (options) {
      return { ...base, kind: "select", options, default: str(p.default) };
    }
    if (type === undefined) return null;
    const format = typeof p.format === "string" && FORMATS.has(p.format) ? p.format : undefined;
    return {
      ...base,
      kind: "text",
      format: format as "email" | "uri" | "date" | "date-time" | undefined,
      minLength: num(p.minLength),
      maxLength: num(p.maxLength),
      default: typeof p.default === "string" ? p.default : undefined,
    };
  }
  if (type === "number" || type === "integer") {
    return {
      ...base,
      kind: "number",
      integer: type === "integer",
      minimum: num(p.minimum),
      maximum: num(p.maximum),
      default: num(p.default),
    };
  }
  if (type === "boolean") {
    return { ...base, kind: "boolean", default: typeof p.default === "boolean" ? p.default : undefined };
  }
  return null;
}

/** The http(s) url to open, or null — never hand a `file:`/`javascript:`/custom-scheme
 *  link to the system opener on a remote server's say-so. */
function openable(url: string | null): { url: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { url: u.href, host: u.host };
  } catch {
    return null;
  }
}

/** Read an elicitation out of a pending request's `input`. Tolerant: a malformed
 *  payload yields an empty form (a plain accept/decline), never a throw. */
export function parseElicitation(input: JsonValue): Elicitation {
  const o = asObject(input);
  const mode = o.mode === "url" ? "url" : "form";
  const url = str(o.url) ?? null;
  const link = openable(url);
  const schema = asObject(o.requested_schema);
  const props = asObject(schema.properties);
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
  );
  const fields: ElicitField[] = [];
  const unsupported: Elicitation["unsupported"] = [];
  if (mode === "form") {
    for (const [key, raw] of Object.entries(props)) {
      const field = parseField(key, raw ?? null, required.has(key));
      if (field) fields.push(field);
      else unsupported.push({ key, label: str(asObject(raw).title) ?? key, required: required.has(key) });
    }
  }
  return {
    server: str(o.display_name) ?? str(o.server_name) ?? "An MCP server",
    message: str(o.message) ?? "",
    mode,
    url,
    openableUrl: link?.url ?? null,
    urlHost: link?.host ?? null,
    fields,
    unsupported,
  };
}

/** Whether the form can be submitted at all: a required field we cannot render
 *  could only be answered with a lie (or an omission the server will reject). */
export function canSubmit(e: Elicitation): boolean {
  return !e.unsupported.some((u) => u.required);
}

/** The starting value of every field: the schema's default, else empty. */
export function initialValues(fields: ElicitField[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    switch (f.kind) {
      case "boolean":
        out[f.key] = f.default ?? false;
        break;
      case "multiselect":
        out[f.key] = f.default ?? [];
        break;
      case "number":
        out[f.key] = f.default !== undefined ? String(f.default) : "";
        break;
      default:
        out[f.key] = f.default ?? "";
    }
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Validate one field's value. Returns the message to show, or null when it is fine. */
export function fieldError(f: ElicitField, value: FieldValue | undefined): string | null {
  if (f.kind === "boolean") return null;
  if (f.kind === "multiselect") {
    const picked = Array.isArray(value) ? value : [];
    if (f.required && picked.length === 0) return "Pick at least one option.";
    if (picked.length === 0) return null;
    if (f.minItems !== undefined && picked.length < f.minItems) return `Pick at least ${f.minItems}.`;
    if (f.maxItems !== undefined && picked.length > f.maxItems) return `Pick at most ${f.maxItems}.`;
    return null;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return f.required ? "Required." : null;
  if (f.kind === "select") {
    return f.options.some((o) => o.value === text) ? null : "Pick one of the options.";
  }
  if (f.kind === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return "Enter a number.";
    if (f.integer && !Number.isInteger(n)) return "Enter a whole number.";
    if (f.minimum !== undefined && n < f.minimum) return `Must be at least ${f.minimum}.`;
    if (f.maximum !== undefined && n > f.maximum) return `Must be at most ${f.maximum}.`;
    return null;
  }
  if (f.minLength !== undefined && text.length < f.minLength) return `At least ${f.minLength} characters.`;
  if (f.maxLength !== undefined && text.length > f.maxLength) return `At most ${f.maxLength} characters.`;
  if (f.format === "email" && !EMAIL.test(text)) return "Enter an email address.";
  if (f.format === "uri" && !openable(text) && !/^[a-z][a-z0-9+.-]*:/iu.test(text)) return "Enter a URL.";
  if (f.format === "date" && !DATE.test(text)) return "Use the YYYY-MM-DD format.";
  if (f.format === "date-time" && Number.isNaN(Date.parse(text))) return "Enter a date and time.";
  return null;
}

/** Turn the edited values into the answer's `content`, or the per-field errors.
 *  Empty optional fields are omitted (absent ≠ an empty string the server must parse);
 *  numbers are sent as numbers, booleans as booleans. */
export function buildContent(
  fields: ElicitField[],
  values: Record<string, FieldValue>,
): { ok: true; content: Record<string, JsonValue> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const content: Record<string, JsonValue> = {};
  for (const f of fields) {
    const v = values[f.key];
    const err = fieldError(f, v);
    if (err) {
      errors[f.key] = err;
      continue;
    }
    if (f.kind === "boolean") {
      content[f.key] = v === true;
    } else if (f.kind === "multiselect") {
      const picked = Array.isArray(v) ? v : [];
      if (picked.length) content[f.key] = picked;
    } else {
      const text = typeof v === "string" ? v.trim() : "";
      if (!text) continue;
      content[f.key] = f.kind === "number" ? Number(text) : text;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, content };
}

/** The one line the attention surfaces show for an elicitation (Flight Deck card,
 *  notification, voice): its message, else what kind of step it is. */
export function elicitationSummary(e: Elicitation): string {
  if (e.message) return e.message;
  return e.mode === "url" ? "Open a page in the browser to continue." : "Answer a few questions to continue.";
}
