// Canned `ServerDiagnosis` values — the ONE place they are spelled out field by field,
// shared by the browser mock (`mockBindings.ts`) and every test that needs one. A new
// `ServerDiagnosis` field is added here, once: the type checker only flags a COMPLETE
// literal, so a fixture built by spreading or overriding another would otherwise
// silently inherit whatever its base said (an unreachable server carrying a ready
// server's facts).
import type { ServerDiagnosis } from "../bindings";

/** A reachable, healthy Linux server: a system unit, its daemon running and current,
 *  Claude installed and signed in, reboot-safe. `over` replaces any field. */
export function readyDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
  return {
    state: { kind: "ready" },
    reachable: true,
    link_issue: null,
    tailscale_off_locally: null,
    host_os: null,
    auto_login: null,
    agent_starts_at_login: null,
    launch_agent_plists: [],
    invalid_launch_agent_plists: [],
    installed_as: "system",
    daemon_running: true,
    daemon_process_seen: true,
    daemon_process_check_error: null,
    daemon_version_disk: "0.4.2",
    daemon_version_running: "0.4.2",
    restart_pending: false,
    reboot_safe: true,
    linger: null,
    sleep_masked: true,
    user_unit_missing_path: null,
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    claude_login_check_error: null,
    tailscale_name: "mock-server.tail1234.ts.net",
    last_boot: "2026-09-15 08:12:03",
    busy_conversations: 0,
    bundled_daemon_version: null,
    daemon_outdated: false,
    ...over,
  };
}

/** A server the diagnosis never reached: every fact unknown (`null`, never `false`),
 *  the shape of `ServerDiagnosis::unreachable_with` (Rust). Defaults to a plain
 *  "could not reach the server" (`link_issue: "unreachable"`); `over` sets the
 *  classification (`link_issue`, `state`, `tailscale_off_locally`). */
export function unreachableDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
  return {
    state: { kind: "failed", reason: "could not reach the server" },
    reachable: false,
    link_issue: "unreachable",
    tailscale_off_locally: null,
    host_os: null,
    auto_login: null,
    agent_starts_at_login: null,
    launch_agent_plists: [],
    invalid_launch_agent_plists: [],
    installed_as: "unknown",
    daemon_running: null,
    daemon_process_seen: null,
    daemon_process_check_error: null,
    daemon_version_disk: null,
    daemon_version_running: null,
    restart_pending: false,
    reboot_safe: null,
    linger: null,
    sleep_masked: null,
    user_unit_missing_path: null,
    claude_installed: null,
    claude_logged_in: null,
    claude_email: null,
    claude_login_check_error: null,
    tailscale_name: null,
    last_boot: null,
    busy_conversations: null,
    bundled_daemon_version: null,
    daemon_outdated: false,
    ...over,
  };
}
