import { beforeEach, describe, expect, it } from "vitest";
import { isSticky, pushInfoToast, useToasts } from "./toasts";

// A sticky toast carries news the user must not miss (a one-shot repair that moved their
// conversations): only the user removes it — a burst of newer toasts must not push it out.
describe("toasts — sticky info", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("marks only the toasts asked to stay", () => {
    pushInfoToast("plain");
    pushInfoToast("keep me", { sticky: true });
    const [plain, kept] = useToasts.getState().toasts;
    expect(isSticky(plain)).toBe(false);
    expect(isSticky(kept)).toBe(true);
  });

  it("over the cap, the oldest NON-sticky toast gives way", () => {
    pushInfoToast("keep me", { sticky: true });
    for (let i = 0; i < 6; i++) pushInfoToast(`noise ${i}`);
    const texts = useToasts.getState().toasts.map((t) => (t.kind === "info" ? t.text : ""));
    expect(texts).toEqual(["keep me", "noise 3", "noise 4", "noise 5"]);
  });

  it("is still dismissed by the user", () => {
    pushInfoToast("keep me", { sticky: true });
    const [t] = useToasts.getState().toasts;
    useToasts.getState().dismiss(t.id);
    expect(useToasts.getState().toasts).toEqual([]);
  });
});
