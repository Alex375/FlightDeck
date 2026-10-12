// Where a conversation's attached NON-image files go: nowhere for a conversation on this Mac (the
// file is mentioned where it is), COPIED to the server for one on a paired server — whose agent
// reads that server's disk, not this Mac's (see `composerAttachments.ts`).
//
// Its own module because `composerAttachments` cannot read the conversations store (that store
// imports it — a cycle); every caller of `attachPaths` passes `upload: remoteUploadFor(id)`.

import { commands } from "../../ipc/client";
import { convServerName, useConversationsStore } from "../../store/conversationsStore";
import type { UploadResult } from "./composerAttachments";

/** The uploader `attachPaths` needs for this conversation: `undefined` on this Mac, else a copy
 *  to its server through `upload_attachment` (routed by the conversation id in the core), whose
 *  refusal sentence names the file and the server. */
export function remoteUploadFor(convId: string): ((path: string) => Promise<UploadResult>) | undefined {
  if (!convServerName(useConversationsStore.getState(), convId)) return undefined;
  return async (path) => {
    const res = await commands.uploadAttachment(convId, path);
    return res.status === "ok" ? { path: res.data } : { error: res.error };
  };
}
