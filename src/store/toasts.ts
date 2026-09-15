// In-app toasts: short-lived notes stacked in a corner of the window, rendered by
// `ToastHost`. Distinct from the OS notification channels (banner / sound / Dock), which
// signal an agent needing YOU; a toast reports something that just happened in the app
// while you look at it — today, one conversation messaging another.

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

export interface InfoToast {
  kind: "info";
  text: string;
}

export type ToastData = AgentMessageToast | InfoToast;
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
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-MAX_TOASTS) }));
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

/** A plain informational toast (e.g. a jump whose target could not be found). */
export function pushInfoToast(text: string): void {
  useToasts.getState().push({ kind: "info", text });
}
