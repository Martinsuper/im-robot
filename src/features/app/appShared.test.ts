import { describe, expect, it } from "vitest";
import {
  defaultLive2DModelId,
  getAvailablePetVisualStyleOptions,
  getLive2DProfileUrl,
  getNextLive2DModelId,
  getNextPetVisualStyle,
  live2dModelOptions,
} from "./appShared";

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

describe("live2d model registry", () => {
  it("keeps only bundled models enabled by default", () => {
    expect(defaultLive2DModelId).toBe("official-hiyori");
    expect(live2dModelOptions.filter((option) => option.enabled).map((option) => option.value)).toEqual([
      "official-hiyori",
      "official-wanko",
      "official-haru",
      "official-natori",
      "official-ren",
      "official-rice",
      "official-mark",
      "official-mao",
    ]);
  });

  it("resolves registered profile urls", () => {
    expect(getLive2DProfileUrl("official-hiyori")).toBe("/live2d/profiles/official-hiyori.profile.json");
    expect(getLive2DProfileUrl("official-mao")).toBe("/live2d/profiles/official-mao.profile.json");
    expect(getLive2DProfileUrl("official-epsilon")).toBe("/live2d/profiles/official-epsilon.profile.json");
  });

  it("cycles through bundled official models", () => {
    expect(getNextLive2DModelId("official-hiyori")).toBe("official-wanko");
    expect(getNextLive2DModelId("official-wanko")).toBe("official-haru");
    expect(getNextLive2DModelId("official-mark")).toBe("official-mao");
    expect(getNextLive2DModelId("official-mao")).toBe("official-hiyori");
  });
});
