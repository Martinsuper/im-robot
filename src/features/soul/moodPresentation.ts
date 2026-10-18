import type { PetEmotion, PetMode, PetReaction } from "../pet/petState";
export type SoulMood = "calm" | "happy" | "stifled" | "energized";
const EXPRESSIONS: Record<SoulMood, PetEmotion> = {
  calm: "neutral", happy: "happy", stifled: "thoughtful", energized: "excited",
};
/** Task state and direct interactions always take precedence over background mood. */
export function moodExpression(mood: SoulMood, mode: PetMode, reaction: PetReaction, current: PetEmotion): PetEmotion {
  if (mode !== "idle" || reaction !== "none" || mood === "calm") return current;
  return EXPRESSIONS[mood] ?? current;
}
