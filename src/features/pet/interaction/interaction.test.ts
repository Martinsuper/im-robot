import { describe, expect, it } from "vitest";
import { InteractionManager } from "./InteractionManager";

const baseContext = {
  quietMode: "balanced" as const,
  petMode: "idle",
  petEmotion: "neutral",
  isResting: false,
  recentInteractionCount: 0,
  intimacy: 0,
  energy: 1,
};

describe("InteractionManager", () => {
  it("maps click to a greeting interaction", () => {
    const manager = new InteractionManager();
    const result = manager.handle({ type: "click", timestamp: Date.now() }, baseContext);

    expect(result.petEvent).toEqual({ type: "INTERACT" });
    expect(result.openBubble).toBe(true);
    expect(result.sound).toBe("click");
  });

  it("maps pet stroke to a direct pet reaction", () => {
    const manager = new InteractionManager();
    const result = manager.handle({ type: "pet_stroke", timestamp: Date.now() }, baseContext);

    expect(result.petEvent).toEqual({ type: "PET_STROKED" });
    expect(result.emotion).toBe("happy");
  });

  it("keeps minimal mode quiet", () => {
    const manager = new InteractionManager();
    const result = manager.handle(
      { type: "hover", timestamp: Date.now() },
      { ...baseContext, quietMode: "minimal" }
    );

    expect(result.petEvent).toEqual({ type: "HOVER" });
    expect(result.sound).toBeUndefined();
  });
});
