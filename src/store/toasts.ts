// In-app toasts: short-lived notes stacked in a corner of the window, rendered by
// `ToastHost`. Distinct from the OS notification channels (banner / sound / Dock), which
// signal an agent needing YOU; a toast reports something that just happened in the app
// while you look at it — today, one conversation messaging or creating another.

import { create } from "zustand";
import { useDisplay } from "./display";

export interface AgentMessageToast {
  kind: "agent-message";
  fromConvId: string;
  toConvId: string;
  /** Snapshots for a conversation that is gone by the time the toast renders. */
  fromTitle: string;
  toTitle: string;
  messageId: string;
  excerpt: string;
}

export interface ConversationCreatedToast {
  kind: "conversation-created";
  fromConvId: string;
  fromTitle: string;
  convId: string;
  title: string;
  repo: string;
  /** Its first message, when it was given one — the jump then lands on it. */
  messageId: string | null;
}

export interface InfoToast {
  kind: "info";
  text: string;
  /** Stays until the user dismisses it (no auto-expiry, never evicted by newer toasts) —
   *  for news the user must not miss, like a one-shot repair that moved their data. */
  sticky?: boolean;
}

export type ToastData = AgentMessageToast | ConversationCreatedToast | InfoToast;
export type Toast = ToastData & { id: number };

/** Oldest toasts give way beyond this — a burst of messages must not wall off the window. */
const MAX_TOASTS = 4;

interface ToastState {
  toasts: Toast[];
  push: (toast: ToastData) => number;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = ++seq;
    set((s) => {
      const toasts = [...s.toasts, { ...toast, id }];
      // Over the cap, the oldest NON-sticky toast gives way — a sticky one is only ever
      // removed by the user.
      while (toasts.length > MAX_TOASTS) {
        const i = toasts.findIndex((t) => !isSticky(t));
        if (i < 0) break;
        toasts.splice(i, 1);
      }
      return { toasts };
    });
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Announce a message between two conversations, unless the user switched the toast off
 *  (Settings → Notifications). Returns whether a toast was shown. */
export function pushAgentMessageToast(toast: Omit<AgentMessageToast, "kind">): boolean {
  if (!useDisplay.getState().agentMessageToasts) return false;
  useToasts.getState().push({ kind: "agent-message", ...toast });
  return true;
}

/** Announce a conversation that another conversation just created, unless the user switched
 *  that toast off (Settings → Notifications). Returns whether a toast was shown. */
export function pushConversationCreatedToast(toast: Omit<ConversationCreatedToast, "kind">): boolean {
  if (!useDisplay.getState().agentCreationToasts) return false;
  useToasts.getState().push({ kind: "conversation-created", ...toast });
  return true;
}

/** Whether a toast stays until the user dismisses it. */
export function isSticky(toast: ToastData): boolean {
  return toast.kind === "info" && !!toast.sticky;
}

/** A plain informational toast (e.g. a jump whose target could not be found). `sticky`
 *  keeps it on screen until dismissed. */
export function pushInfoToast(text: string, opts?: { sticky?: boolean }): void {
  useToasts.getState().push({ kind: "info", text, ...(opts?.sticky ? { sticky: true } : {}) });
}
