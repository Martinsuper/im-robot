import { describe, expect, it } from "vitest";
import { suggestionsFor } from "./chatSuggestions";

function at(hour: number): Date {
  return new Date(2026, 2, 10, hour, 0, 0);
}

describe("suggestionsFor", () => {
  it("早上推「梳理今天」", () => {
    expect(suggestionsFor(at(8))[0].label).toBe("梳理今天");
    expect(suggestionsFor(at(5))[0].label).toBe("梳理今天");
    expect(suggestionsFor(at(11))[0].label).toBe("梳理今天");
  });

  it("下午推整理与记录", () => {
    expect(suggestionsFor(at(12))[0].label).toBe("整理想法");
    expect(suggestionsFor(at(17))[0].label).toBe("整理想法");
  });

  it("晚上推回顾", () => {
    expect(suggestionsFor(at(18))[0].label).toBe("回顾今天");
    expect(suggestionsFor(at(23))[0].label).toBe("回顾今天");
    expect(suggestionsFor(at(2))[0].label).toBe("回顾今天");
  });

  it("每个时段都给三条，且都带可填入的 prompt", () => {
    for (const hour of [2, 8, 14, 20]) {
      const items = suggestionsFor(at(hour));
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.prompt.length).toBeGreaterThan(0);
      }
    }
  });
});
