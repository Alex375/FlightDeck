
import { MACHINE } from "../ui/platform";// What a conversation on a PAIRED SERVER cannot do from this Mac — and the words that say why.
//
// A conversation whose folder lives on a server (`Repo.machineId`) runs its `claude` THERE,
// under flightdeckd: its transcript, its files, its git checkout, its shell and its `~/.claude`
// are that machine's. The surfaces below all read or write THIS Mac's. On a remote conversation
// they would fail with a raw error — or worse, act on an unrelated local folder that happens to
// share the path (a common setup: the same repository at the same path on both machines).
//
// So each one is NOT offered there, and says why, NAMING the server (the project rule: a control
// we cannot honour is refused saying why, never left to fail). The sentences live here, pure and
// import-free, so every surface words a refusal the same way and the store guards reuse them.
// A bugfix, not a feature: none of this has a setting.

/** The name a refusal gives the server a conversation runs on: its label, or — for a machine id
 *  that names nothing any more — a phrase that still says "a server", never "this Mac". */
export function serverLabel(
  machines: ReadonlyArray<{ id: string; label: string }>,
  machineId: string,
): string {
  const label = machines.find((m) => m.id === machineId)?.label.trim();
  return label || "a server that is no longer paired";
}

/** Rewind and fork cut or copy the transcript on THIS Mac's disk; a server's lives on the server
 *  (and its `claude`, owned by flightdeckd, would have to be stopped THERE before any cut). */
export function rewindForkUnavailable(server: string): string {
  return `Rewind and fork aren't available yet for a conversation on ${server} — its history lives on that server, not on this ${MACHINE}.`;
}

/** The title-bar "open in the system terminal" runs `claude --resume` in a LOCAL Terminal. */
export function openInTerminalUnavailable(server: string): string {
  return `This conversation runs on ${server}. Opening it in this ${MACHINE}'s terminal would resume Claude here, where its session doesn't exist — connect to ${server} over ssh instead.`;
}

/** The side editor (tree + file reads + fs watch) browses this Mac's disk. */
export function editorUnavailable(server: string): string {
  return `The editor shows this ${MACHINE}'s files, and this conversation's files are on ${server} — browsing a server's files isn't available yet.`;
}

/** The integrated terminal is a PTY on this Mac. */
export function terminalUnavailable(server: string): string {
  return `The integrated terminal opens a shell on this ${MACHINE}, and this conversation runs on ${server} — connect to ${server} over ssh from a terminal instead.`;
}

/** The Git views run this Mac's `git`. */
export function gitUnavailable(server: string): string {
  return `The Git views run this ${MACHINE}'s git, and this conversation's checkout is on ${server} — they can't read it yet.`;
}

/** Worktrees are listed, created and removed with this Mac's `git`. */
export function worktreesUnavailable(server: string): string {
  return `Worktrees aren't available yet for a folder on ${server} — Flight Deck lists and creates them with this ${MACHINE}'s git.`;
}

/** Remote Control is switched by a request to the server's `claude`, which needs the link: while
 *  it is down, a toggle could only fail — and its failure would replace the bridge state shown
 *  (a bridge still up on the server, its link included) with an error. */
export function remoteControlNeedsTheLink(server: string): string {
  return `Not connected to ${server} right now — Remote Control can be switched once the link is back.`;
}

/** An MCP server's OAuth sign-in redirects to a listener the CLI opens on ITS host. */
export function mcpSignInUnavailable(server: string): string {
  return `Signing in to an MCP server isn't offered here for a conversation on ${server}: the sign-in page returns to a listener on ${server}, which this ${MACHINE}'s browser can't reach. Run /mcp in a terminal on ${server} to sign in.`;
}
