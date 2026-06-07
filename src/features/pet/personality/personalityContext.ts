import type { GrowthSnapshot } from "../interaction";
import type { InteractionStats } from "../interaction";
import type { PersonalityDimensions } from "./personalityTypes";

function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function derivePersonalityFromSignals(
  stats: Pick<InteractionStats, "totalInteractions" | "clickCount" | "doubleClickCount" | "hoverCount" | "petStrokeCount" | "dragCount" | "dropCount" | "chatCount" | "focusCount" | "intimacy">,
  growth: Pick<GrowthSnapshot, "level" | "attributeLevels">
): PersonalityDimensions {
  const total = Math.max(0, stats.totalInteractions);
  const clickEnergy = stats.clickCount * 0.12 + stats.doubleClickCount * 0.16 + stats.dragCount * 0.08;
  const focusEnergy = stats.focusCount * 0.22 + growth.level * 0.03;
  const calmDrain = Math.min(0.9, total * 0.015);

  const energy = clamp(clickEnergy + focusEnergy - calmDrain - 0.35);

  const humorLift =
    stats.petStrokeCount * 0.18 +
    stats.doubleClickCount * 0.1 +
    stats.hoverCount * 0.04 +
    growth.attributeLevels.bond * 0.07;
  const humorDrain = stats.focusCount * 0.05 + Math.max(0, total - 10) * 0.01;
  const humor = clamp(humorLift - humorDrain - 0.25);

  const curiosityLift =
    stats.chatCount * 0.16 +
    stats.dropCount * 0.22 +
    stats.hoverCount * 0.09 +
    stats.intimacy * 0.012;
  const curiosityDrain = stats.focusCount * 0.03 + Math.max(0, total - 8) * 0.008;
  const curiosity = clamp(curiosityLift - curiosityDrain - 0.3);

  return {
    energy,
    humor,
    curiosity,
  };
}

export function describePersonality(personality: PersonalityDimensions): string {
  const energy = personality.energy > 0.35 ? "更活跃" : personality.energy < -0.35 ? "更安静" : "节奏平稳";
  const humor = personality.humor > 0.35 ? "偏调皮" : personality.humor < -0.35 ? "更认真" : "幽默均衡";
  const curiosity = personality.curiosity > 0.35 ? "更好奇" : personality.curiosity < -0.35 ? "更克制" : "好奇适中";
  return `${energy}、${humor}、${curiosity}`;
}
