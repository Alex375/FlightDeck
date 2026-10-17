// React binding for the pure link view (agent/remoteLink.ts): a conversation's live link, its
// server's name and this Mac's network, with a clock that ticks ONLY while the text counts down —
// a link that is up costs one store read and nothing else.
import { useEffect, useState } from "react";
import { commands } from "../ipc/client";
import { useAppErrors } from "../store/appErrors";
import { useConversationStore } from "../store/conversationStore";
import { convServerName, useConversationsStore } from "../store/conversationsStore";
import { useOnline } from "../store/online";
import { remoteLinkView, type RemoteLinkView } from "./remoteLink";

/** What conversation `convId`'s remote link is doing right now, or `null` when it is not down. */
export function useRemoteLinkView(convId: string): RemoteLinkView | null {
  const link = useConversationStore((s) => s.sessions[convId]?.state?.link ?? null);
  const ended = useConversationStore((s) => s.sessions[convId]?.state?.ended === true);
  const server = useConversationsStore((s) => (link ? convServerName(s, convId) : null));
  const online = useOnline();
  const [now, setNow] = useState(() => Date.now());
  // A new step of the outage (a dial, a wait with a new due time) is read against the clock of
  // THAT moment — the last tick may be up to a period old, and would lengthen the wait shown.
  const step = link ? `${link.kind}:${link.attempt}:${link.retry_at_ms}` : null;
  useEffect(() => {
    if (step !== null) setNow(Date.now());
  }, [step]);
  const view = remoteLinkView(link, now, { server, online, ended });
  const tickMs = view?.tickMs ?? null;
  useEffect(() => {
    if (tickMs === null) return;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return view;
}

/** "Retry now": every remote link that is down cuts its wait short (the core's `ReconnectNow`).
 *  The state that follows — dialing, then attached or a new wait — is the answer; only a command
 *  that could not even be delivered is reported, as an app error. */
export function retryRemoteLinksNow(): void {
  const fail = (detail: string) => useAppErrors.getState().pushError("Couldn't retry the server connections", detail);
  commands
    .reconnectRemoteSessions()
    .then((res) => {
      if (res.status === "error") fail(res.error);
    })
    .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
}
