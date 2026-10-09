import { openUrl } from "@tauri-apps/plugin-opener";
import { ChipBtn, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useSetRemoteControl } from "../../ipc/useCommands";
import { statusOf, useRemoteControl } from "../../store/remoteControl";
import { useAppErrors } from "../../store/appErrors";
import { useConversationStore } from "../../store/conversationStore";
import { remoteControlNeedsTheLink } from "../../store/remoteGates";
import { useConvServer } from "./ConvMark";
import type { BackendKind } from "../../store/conversationsStore";

/** Copy a value to the clipboard, surfacing a failure (clipboard blocked / unavailable)
 *  instead of the silent no-op an `?.` + `void` would give — same pattern as the file tree. */
async function copyText(value: string, whatFailed: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    useAppErrors.getState().pushError(whatFailed, String(err));
  }
}

/**
 * Composer chip for native Remote Control — bridges THIS conversation to a phone/web so it
 * can be viewed and driven from another device. Backend-aware:
 *
 *  - **Claude** (`/remote-control`): bridges onto claude.ai/code + the Claude mobile app and
 *    hands back a session URL. Messages from the phone/web arrive inline on the normal stream.
 *    The active menu offers open-in-browser · copy-link · disable.
 *  - **Codex** (`remoteControl/enable`): brings up the OpenAI relay bridge and returns a
 *    device-PAIRING CODE (no URL). The active menu shows that code (to enter in the Codex
 *    mobile app) · copy-code · disable.
 *
 * Icon-only (globe) with a status dot: green = connected/active, red = error, pulsing =
 * connecting. Inactive states render a DIRECT toggle (one click enables — lazily spawning
 * the session if needed, since the bridge rides the live process).
 */
export function RemoteControlChip({
  session,
  backend,
  worktreeOnSpawn,
}: {
  session: string;
  /** Which backend's remote-control wire to drive (its state shape is shared, but the
   *  active-menu UX differs: Claude shows a URL, Codex shows a pairing code). */
  backend: BackendKind;
  /** Pending "start in a fresh worktree" choice (only meaningful before the session
   *  spawns) — forwarded so enabling remote control on a brand-new conversation still
   *  honors it instead of silently spawning in the main checkout. */
  worktreeOnSpawn?: boolean;
}) {
  const rc = useRemoteControl(session);
  const status = statusOf(rc);
  const remote = useSetRemoteControl(session);
  const connecting = status === "connecting" || remote.isPending;
  const isCodex = backend === "codex";
  const url = rc?.session_url ?? null;
  const pairingCode = rc?.pairing_code ?? null;
  // A remote conversation whose link is down (reconnecting, or its first link still coming
  // up): switching the bridge is a request to the server's `claude`, which cannot get there —
  // so it is not offered, saying why. What the chip shows of the bridge stays as it is.
  const server = useConvServer(session);
  const linkDown = useConversationStore((s) => {
    const state = s.sessions[session]?.state;
    return !!state?.link && !state.ended;
  });
  const unreachable = linkDown && server ? remoteControlNeedsTheLink(server) : null;

  // The active (menu) state tracks the BRIDGE being up — NOT the presence of a pairing code.
  // (If enable succeeds but pairing/start fails, the bridge is live server-side with no code;
  // gating on the code alone would render the chip as OFF and strand a live bridge with no way
  // to disable it.) Claude: connected. Codex: connecting or connected — the menu then shows the
  // code, or "unavailable" + the error, and always keeps the Disable action reachable.
  const active = isCodex ? status === "connected" || status === "connecting" : status === "connected";

  if (active) {
    const dotCls = status === "error" ? "err" : status === "connecting" ? "wait pulse" : "run";
    return (
      <Menu
        up
        align="right"
        trigger={
          <ChipBtn
            icon="globe"
            className="cv-rc-chip"
            data-rc={status === "connected" ? "connected" : "active"}
            aria-label="Remote control active"
            title={
              isCodex
                ? "Codex remote control active — pair a device with the code, then drive this session from the Codex app"
                : "Remote control active — this session can be driven from claude.ai/code and the Claude app"
            }
          >
            <span className={`wf-dot ${dotCls}`} aria-hidden />
          </ChipBtn>
        }
      >
        {isCodex ? (
          <>
            <MenuLabel>Codex remote control · {status === "connected" ? "active" : "connecting…"}</MenuLabel>
            <MenuLabel>Pairing code: {pairingCode ?? "unavailable"}</MenuLabel>
            <MenuItem
              icon="copy"
              disabled={!pairingCode}
              onClick={pairingCode ? () => void copyText(pairingCode, "Couldn't copy the pairing code.") : undefined}
            >
              Copy code
            </MenuItem>
            <MenuItem icon="stop" onClick={() => remote.mutate({ enabled: false })}>
              Disable
            </MenuItem>
          </>
        ) : (
          <>
            <MenuLabel>Remote control · active</MenuLabel>
            {unreachable ? <MenuLabel>{unreachable}</MenuLabel> : null}
            <MenuItem icon="external" disabled={!url} onClick={url ? () => void openUrl(url) : undefined}>
              Open in browser
            </MenuItem>
            <MenuItem
              icon="copy"
              disabled={!url}
              onClick={url ? () => void copyText(url, "Couldn't copy the remote control link.") : undefined}
            >
              Copy link
            </MenuItem>
            <MenuItem
              icon="stop"
              disabled={!!unreachable}
              onClick={unreachable ? undefined : () => remote.mutate({ enabled: false })}
            >
              Disable
            </MenuItem>
          </>
        )}
      </Menu>
    );
  }

  const isError = status === "error";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={false}
      className="wf-chip cv-rc-chip"
      disabled={connecting || !!unreachable}
      onClick={() => remote.mutate({ enabled: true, worktree: worktreeOnSpawn })}
      aria-label="Remote control"
      title={
        unreachable
          ? unreachable
          : isError && rc?.error
          ? `Remote control failed: ${rc.error} — click to retry`
          : isCodex
            ? "Remote control — drive/follow this conversation from the Codex mobile app (pairing by code)"
            : "Remote control — drive/follow this conversation from claude.ai/code or the Claude mobile app"
      }
    >
      <Ico name="globe" className="sm" />
      {connecting ? <span className="wf-dot wait pulse" aria-hidden /> : null}
      {isError ? <span className="wf-dot err" aria-hidden /> : null}
    </button>
  );
}
