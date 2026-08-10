// One user-made composer button: an icon from the kit set, one action, a tooltip.
//
// Icon-only by design — with a budget this tight (see composerLayout.ts) a label would
// cost several slots. The tooltip is therefore the only place it says what it is, which
// is why `label` is required when the button is created.
//
// A button whose action can't run HERE is rendered DISABLED with the reason in its
// tooltip rather than hidden or silently inert: "the command isn't in this repository"
// is information, and a click that does nothing without saying so is the exact failure
// this codebase refuses.
import type { ReactNode } from "react";
import { useAppErrors } from "../../store/appErrors";
import { CustomFace } from "./composerChipFaces";
import { availability, runComposerAction, type ActionEnv, type ActionHandlers, type ConfigArg } from "./composerActions";
import type { CustomButton } from "./composerLayout";

/**
 * Wrapper that can pin one left-hand chip to icon-only.
 *
 * `display:contents` (see .cv-chipslot) is what makes this free: the wrapper draws no
 * box, so the chip inside stays a direct flex child of the bar — same layout, same gaps
 * — while still being a CSS ANCESTOR, which is all the `[data-compact]` rules need.
 *
 * The user's setting is a FLOOR (always icon-only); the width-driven container query is
 * still the CEILING (everything goes icon-only under 500px). They compose, so there is
 * no precedence to arbitrate.
 */
export function ChipSlot({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <span className="cv-chipslot" data-compact={compact ? "" : undefined}>
      {children}
    </span>
  );
}

export function CustomComposerButton({
  button,
  convId,
  env,
  handlers,
  applyConfig,
  inert,
}: {
  button: CustomButton;
  /** The conversation THIS composer belongs to — never the app's active one. */
  convId: string;
  env: ActionEnv;
  handlers: ActionHandlers;
  applyConfig: (cfg: ConfigArg) => void;
  /** Preview mode (Settings): render it, never run it. */
  inert?: boolean;
}) {
  const av = availability(button, env);
  const title = av.ok ? button.label : `${button.label} — ${av.reason}`;
  return (
    <CustomFace
      icon={button.icon}
      off={!av.ok}
      // ⚠️ NOT the `disabled` attribute: a disabled control takes no pointer events, so
      // its `title` never renders — and the reason it can't run is the one thing the
      // user needs. `aria-disabled` keeps it hoverable (and announced as unavailable)
      // while the click is refused below.
      aria-disabled={!av.ok || inert ? true : undefined}
      title={title}
      aria-label={button.label}
      onClick={
        inert || !av.ok
          ? undefined
          : () => {
              // A `false` means the action declined to do anything. Dropping it would
              // make a dead click look exactly like a successful one, so it goes to the
              // app-error banner (deduped) instead of nowhere.
              if (!runComposerAction(button, convId, handlers, applyConfig)) {
                useAppErrors
                  .getState()
                  .pushError(
                    `"${button.label || "This button"}" did nothing.`,
                    "Its action reported that it had nothing to do here. Check the button in Settings → Composer.",
                  );
              }
            }
      }
    />
  );
}
