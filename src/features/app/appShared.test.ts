import { describe, expect, it } from "vitest";
import { getAvailablePetVisualStyleOptions, getNextPetVisualStyle } from "./appShared";

describe("pet visual style switching", () => {
  it("skips custom image style when no custom image exists", () => {
    expect(getAvailablePetVisualStyleOptions(false).map((option) => option.value)).toEqual([
      "lumi",
      "character",
      "classic",
    ]);
    expect(getNextPetVisualStyle("character", false)).toBe("classic");
    expect(getNextPetVisualStyle("classic", false)).toBe("lumi");
  });

  it("includes custom image style when a custom image exists", () => {
    expect(getAvailablePetVisualStyleOptions(true).map((option) => option.value)).toEqual([
      "lumi",
      "character",
      "custom",
      "classic",
    ]);
    expect(getNextPetVisualStyle("character", true)).toBe("custom");
    expect(getNextPetVisualStyle("custom", true)).toBe("classic");
  });
});
