// Render-null host for the app-control bridge: subscribes to the Rust hub's
// `app_control_request` events, runs each tool through the pure executor
// (appControl.ts) and answers via `app_control_respond`. Mounted once in App —
// inside the tree so it can receive `changeView` (App-local state), exactly how
// `runAppAction` gets it.
//
// Zero-silent-error: every outcome answers the hub — a thrown executor error
// becomes the MCP `isError` text, and a failed respond call is logged. Never
// answering would leave the agent hanging until the Rust-side timeout.
import { useEffect, useRef } from "react";
import { commands, events } from "../ipc/client";
import { executeAppControlTool, type AppControlHelpers } from "./appControl";
import type { View } from "../ui/shortcuts";

export function AppControlHost({
  changeView,
  tosseAvailable,
}: {
  changeView: (view: View) => void;
  tosseAvailable: boolean;
}) {
  // The listener is mounted once (empty deps) but must always use the LIVE
  // changeView / availability (they re-bind on tosse sign-in); refs bridge.
  const changeViewRef = useRef(changeView);
  changeViewRef.current = changeView;
  const tosseRef = useRef(tosseAvailable);
  tosseRef.current = tosseAvailable;

  useEffect(() => {
    let disposed = false;
    const helpers: AppControlHelpers = {
      changeView: (view) => changeViewRef.current(view),
      get tosseAvailable() {
        return tosseRef.current;
      },
    };

    async function handle(payload: {
      request_id: string;
      tool: string;
      args: unknown;
      session: string | null;
    }): Promise<void> {
      let result: unknown = null;
      let error: string | null = null;
      try {
        const args =
          payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
            ? (payload.args as Record<string, unknown>)
            : {};
        result = await executeAppControlTool(payload.tool, args, payload.session, helpers);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      try {
        const res = await commands.appControlRespond(
          payload.request_id,
          (result ?? null) as never,
          error,
        );
        if (res.status !== "ok") console.error("app_control_respond failed:", res.error);
      } catch (e) {
        console.error("app_control_respond threw:", e);
      }
    }

    const un = events.appControlRequestEvent.listen((e) => {
      if (!disposed) void handle(e.payload);
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  return null;
}
