import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAvailablePetVisualStyleOptions,
  getNextPetVisualStyle,
  getPetVisualStyle,
  resolvePetVisualStyle,
} from "./appShared";

describe("pet visual style switching", () => {
  it("缺失自定义图片和无效值使用相同的经典回退", () => {
    expect(resolvePetVisualStyle("custom", false)).toBe("classic");
    expect(resolvePetVisualStyle("custom", true)).toBe("custom");
    expect(resolvePetVisualStyle("obsolete", false)).toBe("classic");
    expect(resolvePetVisualStyle("character", false)).toBe("classic");
    expect(resolvePetVisualStyle(null, false)).toBe("classic");
  });
  it("没有自定义图片时跳过自定义图片风格", () => {
    expect(getAvailablePetVisualStyleOptions(false).map((option) => option.value)).toEqual([
      "lumi",
      "classic",
    ]);
    expect(getNextPetVisualStyle("lumi", false)).toBe("classic");
  });

  it("有自定义图片时包含自定义图片风格", () => {
    expect(getAvailablePetVisualStyleOptions(true).map((option) => option.value)).toEqual([
      "lumi",
      "custom",
      "classic",
    ]);
    expect(getNextPetVisualStyle("lumi", true)).toBe("custom");
    expect(getNextPetVisualStyle("custom", true)).toBe("classic");
  });

  it("classic 存量值与选择器一致", () => {
    // 用最小 localStorage 验证旧用户保存值与可选项一致。
    const store = new Map<string, string>([["piko-pet-visual-style", "classic"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });

    expect(getPetVisualStyle()).toBe("classic");
    expect(getAvailablePetVisualStyleOptions(false).some((option) => option.value === getPetVisualStyle())).toBe(true);
    vi.unstubAllGlobals();
  });

  it("循环切换只在三个可选风格之间进行", () => {
    const seen = new Set<string>();
    let current = getNextPetVisualStyle("lumi", false);
    for (let index = 0; index < 6; index += 1) {
      seen.add(current);
      current = getNextPetVisualStyle(current, false);
    }
    expect(seen).toEqual(new Set(["lumi", "classic"]));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
