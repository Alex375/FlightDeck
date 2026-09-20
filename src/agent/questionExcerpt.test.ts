import { describe, expect, it } from "vitest";
import { questionExcerpt } from "./status";

describe("questionExcerpt", () => {
  it("returns null when there is no question", () => {
    expect(questionExcerpt(null)).toBeNull();
    expect(questionExcerpt("")).toBeNull();
    expect(questionExcerpt("Done. The tests pass.")).toBeNull();
  });

  it("keeps only the trailing question, not the message's opening lines", () => {
    const text =
      "The limiter needs a shared counter across the API pods.\n\n" +
      "I can use the existing cache. One decision is yours: which Redis instance should I use?";
    expect(questionExcerpt(text)).toBe("One decision is yours: which Redis instance should I use?");
  });

  it("keeps a run of consecutive question sentences", () => {
    expect(questionExcerpt("Two options. Should I use A? Or B?")).toBe("Should I use A? Or B?");
  });

  it("drops Markdown markers, links and trailing closers", () => {
    expect(questionExcerpt("Setup done.\n- **Do you want me to push to `dev`?**")).toBe(
      "Do you want me to push to dev?",
    );
    expect(questionExcerpt("See [the plan](https://x.y/z). Shall I start?")).toBe("Shall I start?");
    expect(questionExcerpt("(Should I continue?)")).toBe("Should I continue?");
  });

  it("handles a French space before the question mark", () => {
    expect(questionExcerpt("Veux-tu que je continue ?")).toBe("Veux-tu que je continue ?");
  });

  it("ignores a fenced code block after the question", () => {
    expect(questionExcerpt("Is this the right query?\n```sql\nSELECT 1;\n```")).toBe(
      "Is this the right query?",
    );
  });

  it("caps a very long question with an ellipsis", () => {
    const q = `${"word ".repeat(80).trim()}?`;
    const out = questionExcerpt(q, 50);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(50);
    expect(out!.endsWith("…")).toBe(true);
  });
});
