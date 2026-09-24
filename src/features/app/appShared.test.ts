import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAvailablePetVisualStyleOptions,
  getNextPetVisualStyle,
  getPetVisualStyle,
} from "./appShared";

describe("pet visual style switching", () => {
  it("没有自定义图片时跳过自定义图片风格（R3-5：三选一）", () => {
    expect(getAvailablePetVisualStyleOptions(false).map((option) => option.value)).toEqual([
      "lumi",
      "character",
    ]);
    expect(getNextPetVisualStyle("character", false)).toBe("lumi");
  });

  it("有自定义图片时包含自定义图片风格", () => {
    expect(getAvailablePetVisualStyleOptions(true).map((option) => option.value)).toEqual([
      "lumi",
      "character",
      "custom",
    ]);
    expect(getNextPetVisualStyle("character", true)).toBe("custom");
    expect(getNextPetVisualStyle("custom", true)).toBe("lumi");
  });

  it("classic 仍是合法的存量值，只是不再出现在选择器里", () => {
    // vitest.config 没配 DOM 环境（仓库里没有 jsdom 依赖），这里手动 stub 一个
    // 最小 localStorage：这个测试只关心「存量 classic 不会被校验拒绝」。
    const store = new Map<string, string>([["piko-pet-visual-style", "classic"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });

    expect(getPetVisualStyle()).toBe("classic");
    vi.unstubAllGlobals();
  });

  it("循环切换只在三个可选风格之间进行", () => {
    const seen = new Set<string>();
    let current = getNextPetVisualStyle("lumi", false);
    for (let index = 0; index < 6; index += 1) {
      seen.add(current);
      current = getNextPetVisualStyle(current, false);
    }
    expect(seen).toEqual(new Set(["lumi", "character"]));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
