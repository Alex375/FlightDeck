// Shared classification of a pending permission request into the human "ask" the
// UI shows — the real question / command / file behind a `can_use_tool` prompt.
// Used by BOTH the conversation thread (AskTurn) and the FlightDeck card's
// StateBlock, so the two render the same prompt from one source of truth. Pure +
// React-free → unit-testable (see ask.test.ts).
import type { JsonValue, PermissionRequestPayload } from "../ipc/client";

export interface Ask {
  kind: "question" | "permission" | "error" | "blocked";
  text?: string;
  /** A shell command to preview (Bash permissions). */
  cmd?: string;
  /**
   * Why the CLI is asking, when it says so — a blocked path (an edit outside the
   * session's worktree or the allowed directories) and/or its own stated reason.
   * Without this the card reads as an ordinary tool request and the user has no
   * idea a restriction is what triggered it.
   */
  reason?: string;
}

/** Read a string field from a tool_use input object (the permission `input`). */
export function field(input: JsonValue, key: string): string | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const v = (input as Record<string, JsonValue>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Classify a permission request into the ask shown to the user. A Bash request
 * previews its command; an edit/write previews the target file; anything else
 * falls back to the tool name. Note: the `AskUserQuestion` questionnaire is NOT
 * handled here — callers branch on it first (it has its own multi-question UI).
 */
export function classifyAsk(req: PermissionRequestPayload): Ask {
  const reason = askReason(req);
  if (req.tool_name === "Bash") {
    return {
      kind: "permission",
      text: "Allow running the command?",
      cmd: field(req.input, "command"),
      reason,
    };
  }
  const target = field(req.input, "file_path");
  return {
    kind: "permission",
    text:
      req.description ||
      (target ? `Allow editing ${target}?` : `Allow ${req.tool_name}?`),
    reason,
  };
}

/**
 * The "why" line of a permission prompt, built from whatever the CLI provided.
 *
 * `blocked_path` names the path that tripped a restriction; `decision_reason` is
 * the CLI's own explanation and is NOT contractual in shape — it may be a plain
 * string, or an object carrying one under a conventional key. Anything else is
 * dropped rather than stringified: dumping raw JSON onto a permission card is
 * worse than saying nothing. Returns undefined when there is nothing to say.
 */
export function askReason(req: PermissionRequestPayload): string | undefined {
  const parts: string[] = [];
  const why = reasonText(req.decision_reason);
  if (why) parts.push(why);
  if (req.blocked_path) parts.push(`Blocked path: ${req.blocked_path}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function reasonText(raw: JsonValue): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, JsonValue>;
    for (const key of ["message", "reason", "description", "type"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}
