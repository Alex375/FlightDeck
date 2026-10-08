import { useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonValue, PermissionRequestPayload } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { Ico } from "../../ui/kit";
import { AiAvatar } from "./ConvMark";
import {
  buildContent,
  canSubmit,
  initialValues,
  parseElicitation,
  type ElicitField,
  type FieldValue,
} from "../../agent/elicitation";

// MCP elicitation card — an MCP server stopped mid tool call to ask the user for
// something. Two shapes:
//   - form: the fields of the server's flat JSON Schema, validated here, sent back as
//     the answer's content (accept) — or declined;
//   - url: a page to open in the browser (a sign-in, a payment…). Nothing opens on its
//     own: the user sees the host first, and "Open in browser" both opens it and tells
//     the server they agreed (accept), the server then waits for the step to finish.
// The server's text is shown as plain text, never Markdown: it is a third party's.

/** Above this many options a choice renders as a dropdown instead of a radio list. */
const MAX_RADIO_OPTIONS = 8;

export function ElicitationAsk({
  session,
  request,
}: {
  session: string;
  request: PermissionRequestPayload;
}) {
  const answer = useAnswerPermission(session);
  const el = useMemo(() => parseElicitation(request.input), [request.input]);
  const heading = request.title?.trim() || el.message || "The server needs your input.";
  // The message, when the server's title took the heading spot.
  const body = request.title?.trim() && el.message ? el.message : null;

  const accept = (content?: Record<string, JsonValue>) =>
    answer.mutate({
      requestId: request.request_id,
      decision: { behavior: "allow", updated_input: content ?? null },
    });
  const decline = () =>
    answer.mutate({
      requestId: request.request_id,
      decision: { behavior: "deny", message: "The user declined." },
    });

  return (
    <div className="cv-msg cv-ai">
      <AiAvatar session={session} />
      <div className="cv-aibody">
        <div className="cv-q cv-el">
          <div className="cv-q-head">
            <Ico name={el.mode === "url" ? "external" : "form"} className="sm" />
            <span className="cv-el-heading">{heading}</span>
          </div>
          {body ? <div className="cv-el-msg">{body}</div> : null}
          <div className="cv-el-src">
            <Ico name="plug" className="sm" />
            Asked by the MCP server <b>{el.server}</b>
          </div>
          {el.mode === "url" ? (
            <UrlStep el={el} onAccept={() => accept()} onDecline={decline} />
          ) : (
            <FormStep el={el} onSubmit={accept} onDecline={decline} />
          )}
        </div>
      </div>
    </div>
  );
}

function UrlStep({
  el,
  onAccept,
  onDecline,
}: {
  el: ReturnType<typeof parseElicitation>;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const open = () => {
    if (!el.openableUrl) return;
    setOpenError(null);
    // Answer only once the browser actually got the link: an accept on a failed open
    // would leave the server waiting on a step the user never saw.
    openUrl(el.openableUrl).then(onAccept, (e: unknown) => {
      setOpenError(`Unable to open the browser: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const copy = () => {
    if (!el.url) return;
    navigator.clipboard.writeText(el.url).then(
      () => setCopied(true),
      (e: unknown) => setOpenError(`Unable to copy the link: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  return (
    <>
      {el.url ? (
        <div className="cv-el-link">
          {el.urlHost ? (
            <div className="cv-el-host">
              Opens <b>{el.urlHost}</b>
            </div>
          ) : (
            <div className="cv-el-warn">
              This link is not a web address — Flight Deck will not open it.
            </div>
          )}
          <code className="cv-el-url wf-mono" title={el.url}>
            {el.url}
          </code>
        </div>
      ) : (
        <div className="cv-el-warn">The server did not send a link to open.</div>
      )}
      {openError ? <div className="cv-el-warn">{openError}</div> : null}
      <div className="cv-q-foot">
        <button className="wf-btn ghost sm" onClick={onDecline}>
          Decline
        </button>
        <span className="cv-el-actions">
          {el.url ? (
            <button className="wf-btn ghost sm" onClick={copy}>
              <Ico name={copied ? "check" : "copy"} className="sm" />
              {copied ? "Copied" : "Copy link"}
            </button>
          ) : null}
          {/* The opener failed: the user may have opened the copied link themselves —
              let them tell the server so, rather than trapping the call. */}
          {openError && el.openableUrl ? (
            <button className="wf-btn ghost sm" onClick={onAccept}>
              I opened it — continue
            </button>
          ) : null}
          {el.openableUrl ? (
            <button className="wf-btn prim sm" onClick={open}>
              <Ico name="external" className="sm" />
              Open in browser
            </button>
          ) : null}
        </span>
      </div>
    </>
  );
}

function FormStep({
  el,
  onSubmit,
  onDecline,
}: {
  el: ReturnType<typeof parseElicitation>;
  onSubmit: (content: Record<string, JsonValue>) => void;
  onDecline: () => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(el.fields));
  // Errors show only after a first submit attempt — not while the user starts typing.
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const submittable = canSubmit(el);
  const blocked = el.unsupported.filter((u) => u.required);
  const skipped = el.unsupported.filter((u) => !u.required);

  const set = (key: string, v: FieldValue) => {
    const next = { ...values, [key]: v };
    setValues(next);
    // Re-validate live once errors are on screen, so a fixed field clears at once.
    if (errors) {
      const res = buildContent(el.fields, next);
      setErrors(res.ok ? {} : res.errors);
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!submittable) return;
    const res = buildContent(el.fields, values);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    onSubmit(res.content);
  };

  return (
    <form className="cv-el-form" onSubmit={submit} noValidate>
      {el.fields.map((f) => (
        <FieldRow key={f.key} field={f} error={errors?.[f.key]}>
          <FieldInput field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
        </FieldRow>
      ))}
      {blocked.length ? (
        <div className="cv-el-warn">
          This form asks for {blocked.map((u) => u.label).join(", ")}, which Flight Deck cannot
          display. You can only decline it here.
        </div>
      ) : null}
      {skipped.length ? (
        <div className="cv-el-note">
          Optional field{skipped.length > 1 ? "s" : ""} not shown (unsupported):{" "}
          {skipped.map((u) => u.label).join(", ")}.
        </div>
      ) : null}
      <div className="cv-q-foot">
        <button type="button" className="wf-btn ghost sm" onClick={onDecline}>
          Decline
        </button>
        <button type="submit" className="wf-btn prim sm" disabled={!submittable}>
          <Ico name="check" className="sm" />
          {el.fields.length ? "Send" : "Accept"}
        </button>
      </div>
    </form>
  );
}

function FieldRow({ field, error, children }: { field: ElicitField; error?: string; children: ReactNode }) {
  // A checkbox carries its own label inline.
  const inlineLabel = field.kind === "boolean";
  return (
    <div className={"cv-el-field" + (error ? " has-err" : "")}>
      {inlineLabel ? null : (
        <div className="cv-el-label">
          {field.label}
          {field.required ? <span className="cv-el-req"> *</span> : null}
        </div>
      )}
      {children}
      {field.description && !inlineLabel ? <div className="cv-el-desc">{field.description}</div> : null}
      {error ? <div className="cv-el-err">{error}</div> : null}
    </div>
  );
}

/** Keep typing keys inside the field: the thread binds bare-key shortcuts. */
const keepKeys = (e: KeyboardEvent) => {
  if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
};

function FieldInput({
  field: f,
  value,
  onChange,
}: {
  field: ElicitField;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
}) {
  if (f.kind === "boolean") {
    const on = value === true;
    return (
      <Choice multi selected={on} onToggle={() => onChange(!on)} label={f.label} description={f.description} />
    );
  }
  if (f.kind === "select" || f.kind === "multiselect") {
    const multi = f.kind === "multiselect";
    const picked = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? [value] : [];
    if (!multi && f.options.length > MAX_RADIO_OPTIONS) {
      return (
        <select
          className="cv-el-input"
          value={picked[0] ?? ""}
          onKeyDown={keepKeys}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    const toggle = (v: string) => {
      if (!multi) return onChange(picked[0] === v && !f.required ? "" : v);
      onChange(picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v]);
    };
    return (
      <div className="cv-q-opts">
        {f.options.map((o) => (
          <Choice
            key={o.value}
            multi={multi}
            selected={picked.includes(o.value)}
            onToggle={() => toggle(o.value)}
            label={o.label}
          />
        ))}
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  const type =
    f.kind === "text"
      ? f.format === "email"
        ? "email"
        : f.format === "uri"
          ? "url"
          : f.format === "date"
            ? "date"
            : "text"
      : "text";
  return (
    <input
      className="cv-el-input"
      type={type}
      inputMode={f.kind === "number" ? (f.integer ? "numeric" : "decimal") : undefined}
      placeholder={f.kind === "text" && f.format === "date-time" ? "YYYY-MM-DDTHH:MM:SSZ" : undefined}
      value={text}
      onKeyDown={keepKeys}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A radio / checkbox row, in the questionnaire's option style. */
function Choice({
  multi,
  selected,
  onToggle,
  label,
  description,
}: {
  multi: boolean;
  selected: boolean;
  onToggle: () => void;
  label: string;
  description?: string;
}) {
  return (
    <div
      className={"cv-q-opt" + (selected ? " is-sel" : "")}
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      <span className={"cv-q-box" + (multi ? " cb" : " rd") + (selected ? " on" : "")}>
        {selected && (multi ? <Ico name="check" className="sm" /> : <span className="cv-q-dot" />)}
      </span>
      <span className="cv-q-opt-main">
        <span className="cv-q-opt-label">{label}</span>
        {description && <span className="cv-q-opt-desc">{description}</span>}
      </span>
    </div>
  );
}
