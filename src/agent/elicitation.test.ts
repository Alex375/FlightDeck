import { describe, expect, it } from "vitest";
import type { JsonValue } from "../ipc/client";
import {
  ELICITATION_TOOL,
  buildContent,
  canSubmit,
  elicitationSummary,
  fieldError,
  initialValues,
  isElicitation,
  parseElicitation,
} from "./elicitation";

/** The `input` the Rust session builds (`ElicitationReq::ui_input`). */
function input(over: Record<string, JsonValue>): JsonValue {
  return {
    server_name: "deploy",
    display_name: null,
    message: "Which environment?",
    mode: "form",
    url: null,
    elicitation_id: null,
    requested_schema: null,
    ...over,
  };
}

describe("isElicitation", () => {
  it("recognises the reserved tool name only", () => {
    expect(isElicitation({ tool_name: ELICITATION_TOOL })).toBe(true);
    expect(isElicitation({ tool_name: "Bash" })).toBe(false);
    expect(isElicitation(null)).toBe(false);
  });
});

describe("parseElicitation", () => {
  it("reads every field kind the MCP spec allows, in schema order", () => {
    const e = parseElicitation(
      input({
        requested_schema: {
          type: "object",
          properties: {
            name: { type: "string", title: "Project name", minLength: 2 },
            email: { type: "string", format: "email" },
            count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
            ratio: { type: "number" },
            confirm: { type: "boolean", title: "I understand", default: true },
            env: { type: "string", enum: ["staging", "prod"], enumNames: ["Staging", "Production"] },
            region: { type: "string", oneOf: [{ const: "eu", title: "Europe" }, { const: "us", title: "US" }] },
            tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } },
          },
          required: ["name", "env"],
        },
      }),
    );
    expect(e.mode).toBe("form");
    expect(e.server).toBe("deploy");
    expect(e.fields.map((f) => [f.key, f.kind])).toEqual([
      ["name", "text"],
      ["email", "text"],
      ["count", "number"],
      ["ratio", "number"],
      ["confirm", "boolean"],
      ["env", "select"],
      ["region", "select"],
      ["tags", "multiselect"],
    ]);
    const env = e.fields.find((f) => f.key === "env");
    expect(env?.required).toBe(true);
    expect(env?.kind === "select" && env.options).toEqual([
      { value: "staging", label: "Staging" },
      { value: "prod", label: "Production" },
    ]);
    expect(e.fields[0].label).toBe("Project name");
    expect(e.unsupported).toEqual([]);
    expect(canSubmit(e)).toBe(true);
  });

  it("flags properties it cannot render, and refuses a submit when one is required", () => {
    const e = parseElicitation(
      input({
        requested_schema: {
          properties: {
            nested: { type: "object", title: "Nested" },
            free: { type: "array" },
          },
          required: ["nested"],
        },
      }),
    );
    expect(e.fields).toEqual([]);
    expect(e.unsupported).toEqual([
      { key: "nested", label: "Nested", required: true },
      { key: "free", label: "free", required: false },
    ]);
    expect(canSubmit(e)).toBe(false);
  });

  it("a form without a schema is a plain confirmation", () => {
    const e = parseElicitation(input({}));
    expect(e.fields).toEqual([]);
    expect(canSubmit(e)).toBe(true);
  });

  it("URL mode exposes the host, and only an http(s) link is openable", () => {
    const ok = parseElicitation(input({ mode: "url", url: "https://auth.example.com/login?x=1", display_name: "GitHub" }));
    expect(ok.mode).toBe("url");
    expect(ok.server).toBe("GitHub");
    expect(ok.openableUrl).toBe("https://auth.example.com/login?x=1");
    expect(ok.urlHost).toBe("auth.example.com");

    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const e = parseElicitation(input({ mode: "url", url: bad }));
      expect(e.url).toBe(bad);
      expect(e.openableUrl).toBeNull();
    }
  });

  it("never throws on a malformed payload", () => {
    const e = parseElicitation(null);
    expect(e.server).toBe("An MCP server");
    expect(e.mode).toBe("form");
    expect(elicitationSummary(e)).toBe("Answer a few questions to continue.");
  });
});

describe("validation and content", () => {
  const e = parseElicitation(
    input({
      requested_schema: {
        properties: {
          name: { type: "string", minLength: 2 },
          email: { type: "string", format: "email" },
          count: { type: "integer", minimum: 1, maximum: 5 },
          confirm: { type: "boolean" },
          env: { type: "string", enum: ["staging", "prod"] },
          tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, maxItems: 2 },
        },
        required: ["name", "env"],
      },
    }),
  );

  it("starts from the schema defaults", () => {
    expect(initialValues(e.fields)).toEqual({
      name: "",
      email: "",
      count: "",
      confirm: false,
      env: "",
      tags: [],
    });
  });

  it("reports each invalid field", () => {
    const res = buildContent(e.fields, {
      name: "x",
      email: "nope",
      count: "2.5",
      confirm: false,
      env: "",
      tags: ["a", "b", "c"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual({
      name: "At least 2 characters.",
      email: "Enter an email address.",
      count: "Enter a whole number.",
      env: "Required.",
      tags: "Pick at most 2.",
    });
  });

  it("coerces types and omits empty optional fields", () => {
    const res = buildContent(e.fields, {
      name: "  Flight Deck ",
      email: "",
      count: "3",
      confirm: true,
      env: "prod",
      tags: [],
    });
    expect(res).toEqual({
      ok: true,
      content: { name: "Flight Deck", count: 3, confirm: true, env: "prod" },
    });
  });

  it("checks numeric bounds and formats", () => {
    const count = e.fields.find((f) => f.key === "count")!;
    expect(fieldError(count, "0")).toBe("Must be at least 1.");
    expect(fieldError(count, "9")).toBe("Must be at most 5.");
    expect(fieldError(count, "abc")).toBe("Enter a number.");
    expect(fieldError(count, "")).toBeNull();
  });
});
