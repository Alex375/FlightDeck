// Front-end mirror of the Rust ssh-argv-injection guard — `src-tauri/src/store/
// model.rs`'s `validate_ssh_user` / `validate_address_value` / `validate_ssh_port` —
// for the "Add a server" surfaces (`ServerBootstrapWizard.tsx`, `ControlSection.tsx`).
//
// CRM holistic-review blocker #3 (chantier A `bd7ca709`): every ssh invocation this
// app makes builds its destination from `user`/`host`. `host` was already validated;
// `user` was validated NOWHERE — a value like `-oProxyCommand=<cmd>` makes the whole
// destination argument start with `-`, so the LOCAL OpenSSH client parses it as an
// OPTION and runs `<cmd>` on this Mac. `user` is not only ever typed by a human
// either: a pairing ticket (`fdpair:<base64 json>`, see `ControlSection.tsx::
// parseTicket`) is printed by the SERVER, so a hostile or compromised server can hand
// back a ticket that pre-fills a malicious `user` and executes code locally the
// moment "Test & pair" runs.
//
// The Rust side (`push_ssh_destination` and everything that funnels through it) is
// the actual security boundary — this module is a UX nicety that refuses a hostile
// ticket, or a hand-typed mistake, BEFORE the round trip to the core even happens.
// A determined attacker could always call the IPC command directly, bypassing this
// entirely, which is exactly why the Rust side re-validates unconditionally too.

/** Mirrors `validate_ssh_user` exactly: non-empty, ≤ 64 characters, must not start
 *  with `-` (the injection class this whole module exists to close), only
 *  `[A-Za-z0-9._-]` plus an optional single trailing `$` (Samba/Active-Directory
 *  machine-account shape, e.g. `WORKGROUP$`) — no whitespace, control characters,
 *  `@`, `:`, or `/`. Returns `null` when valid, or a short user-facing reason. */
export function validateSshUser(value: string): string | null {
  if (value === "") return "User name cannot be empty.";
  if (value.length > 64) return "User name is longer than 64 characters.";
  if (value.startsWith("-")) return 'User name cannot start with "-".';
  const body = value.endsWith("$") ? value.slice(0, -1) : value;
  if (body === "") return 'User name must have characters before a trailing "$".';
  if (!/^[A-Za-z0-9._-]+$/.test(body)) {
    return 'User name may only contain letters, digits, ".", "_", "-" (and an optional trailing "$").';
  }
  return null;
}

/** Mirrors `validate_address_value`: non-empty, must not start with `-`, no
 *  whitespace or control characters. Returns `null` when valid, or a short
 *  user-facing reason. */
export function validateSshHost(value: string): string | null {
  if (value === "") return "Address cannot be empty.";
  if (value.startsWith("-")) return 'Address cannot start with "-".';
  // Deliberately matches control characters (0x00-0x1f, 0x7f) — mirrors the Rust
  // side's `is_control` check.
  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return "Address cannot contain whitespace or control characters.";
  }
  return null;
}

/** Mirrors `validate_ssh_port`: an integer strictly between 1 and 65535. Returns
 *  `null` when valid, or a short user-facing reason. */
export function validateSshPort(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return "Port must be between 1 and 65535.";
  }
  return null;
}

/** The first validation failure among `user`/`host`/`port`, in the order a form
 *  reads top to bottom — or `null` when every one is valid. The single check every
 *  "Add a server" surface (wizard form, legacy manual form, a parsed ticket) runs
 *  before enabling its submit button or advancing past a ticket paste. */
export function firstConnectionFieldError(user: string, host: string, port: number): string | null {
  return validateSshHost(host) ?? validateSshUser(user) ?? validateSshPort(port);
}
