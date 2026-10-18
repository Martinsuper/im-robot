import { describe, expect, it } from "vitest";
import { moodExpression } from "./moodPresentation";
describe("mood presentation priority", () => {
  it("preserves confirmation, errors, rest and direct interactions", () => {
    for (const mode of ["confirming", "error", "resting", "working"] as const)
      expect(moodExpression("happy", mode, "none", "worried")).toBe("worried");
    expect(moodExpression("stifled", "idle", "celebrate", "happy")).toBe("happy");
  });
  it("uses supported idle expressions and removes background mood when calm", () => {
    expect(moodExpression("stifled", "idle", "none", "neutral")).toBe("thoughtful");
    expect(moodExpression("energized", "idle", "none", "neutral")).toBe("excited");
    expect(moodExpression("calm", "idle", "none", "neutral")).toBe("neutral");
  });
});
