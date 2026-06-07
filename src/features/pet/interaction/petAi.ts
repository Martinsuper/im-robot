import { isTauriRuntime, runCommand } from "../../app/appRuntime";
import type { BondTier, BehaviorTag, PersonalityDimensions } from "../personality";

export type PetMotionStyle = "soft" | "balanced" | "lively";
export type PetBehaviorProfile = "calm" | "balanced" | "playful" | "curious" | "focused";
export type PetBehaviorPriority = BehaviorTag[];

export interface PetCompanionGenerationInput {
  mode: "dialogue" | "idleProfile" | "behaviorProfile" | "behaviorPriority";
  scene: string;
  bondTier: BondTier;
  interactionType?: string;
  personality: PersonalityDimensions;
  personalitySummary?: string;
  context?: string;
}

export interface PetCompanionGenerationOutput {
  message?: string;
  motionStyle?: PetMotionStyle;
  behaviorProfile?: PetBehaviorProfile;
  behaviorPriority?: PetBehaviorPriority;
}

function normalizeMotionStyle(value: unknown): PetMotionStyle | undefined {
  if (value === "soft" || value === "balanced" || value === "lively") {
    return value;
  }
  return undefined;
}

function normalizeBehaviorProfile(value: unknown): PetBehaviorProfile | undefined {
  if (
    value === "calm" ||
    value === "balanced" ||
    value === "playful" ||
    value === "curious" ||
    value === "focused"
  ) {
    return value;
  }
  return undefined;
}

function normalizeBehaviorPriority(value: unknown): BehaviorTag[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter(
    (item): item is BehaviorTag =>
      item === "calm" ||
      item === "balanced" ||
      item === "playful" ||
      item === "curious" ||
      item === "focused" ||
      item === "neutral"
  );
  return normalized.length > 0 ? normalized : undefined;
}

export async function generatePetCompanionResponse(
  input: PetCompanionGenerationInput
): Promise<PetCompanionGenerationOutput | null> {
  if (!isTauriRuntime) return null;
  try {
    const result = await runCommand<PetCompanionGenerationOutput>(
      "generate_pet_companion_response",
      input as unknown as Record<string, unknown>,
      undefined
    );
    if (!result) return null;
    return {
      message: typeof result.message === "string" ? result.message.trim() : undefined,
      motionStyle: normalizeMotionStyle(result.motionStyle),
      behaviorProfile: normalizeBehaviorProfile(result.behaviorProfile),
      behaviorPriority: normalizeBehaviorPriority(result.behaviorPriority),
    };
  } catch {
    return null;
  }
}

const idleStyleCache = new Map<string, Promise<PetMotionStyle | null>>();
const behaviorProfileCache = new Map<string, Promise<PetBehaviorProfile | null>>();
const behaviorPriorityCache = new Map<string, Promise<BehaviorTag[] | null>>();

export function resolvePetIdleMotionStyle(
  input: Omit<PetCompanionGenerationInput, "mode" | "scene" | "interactionType" | "context">
): Promise<PetMotionStyle | null> {
  const cacheKey = `${input.bondTier}:${input.personality.energy}:${input.personality.humor}:${input.personality.curiosity}:${input.personalitySummary ?? ""}`;
  const cached = idleStyleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = generatePetCompanionResponse({
    mode: "idleProfile",
    scene: "idle",
    bondTier: input.bondTier,
    personality: input.personality,
    personalitySummary: input.personalitySummary,
    context: "请只返回适合当前关系阶段的闲置动作节奏建议。",
  })
    .then((result) => {
      if (!result?.motionStyle) {
        idleStyleCache.delete(cacheKey);
      }
      return result?.motionStyle ?? null;
    })
    .catch(() => {
      idleStyleCache.delete(cacheKey);
      return null;
    });

  idleStyleCache.set(cacheKey, pending);
  return pending;
}

export function resolvePetBehaviorProfile(
  input: Omit<PetCompanionGenerationInput, "mode" | "scene" | "interactionType" | "context">
): Promise<PetBehaviorProfile | null> {
  const cacheKey = `${input.bondTier}:${input.personality.energy}:${input.personality.humor}:${input.personality.curiosity}:${input.personalitySummary ?? ""}`;
  const cached = behaviorProfileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = generatePetCompanionResponse({
    mode: "behaviorProfile",
    scene: "behavior",
    bondTier: input.bondTier,
    personality: input.personality,
    personalitySummary: input.personalitySummary,
    context: "请只返回适合当前关系阶段和人格状态的主动行为偏好。",
  })
    .then((result) => {
      if (!result?.behaviorProfile) {
        behaviorProfileCache.delete(cacheKey);
      }
      return result?.behaviorProfile ?? null;
    })
    .catch(() => {
      behaviorProfileCache.delete(cacheKey);
      return null;
    });

  behaviorProfileCache.set(cacheKey, pending);
  return pending;
}

export function resolvePetBehaviorPriority(
  input: Omit<PetCompanionGenerationInput, "mode" | "scene" | "interactionType" | "context">
): Promise<BehaviorTag[] | null> {
  const cacheKey = `${input.bondTier}:${input.personality.energy}:${input.personality.humor}:${input.personality.curiosity}:${input.personalitySummary ?? ""}`;
  const cached = behaviorPriorityCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = generatePetCompanionResponse({
    mode: "behaviorPriority",
    scene: "behavior",
    bondTier: input.bondTier,
    personality: input.personality,
    personalitySummary: input.personalitySummary,
    context: "请只返回一个有序的行为偏好标签数组，按照当前最应该优先出现的主动行为类型排序。",
  })
    .then((result) => {
      if (!result?.behaviorPriority?.length) {
        behaviorPriorityCache.delete(cacheKey);
      }
      return result?.behaviorPriority ?? null;
    })
    .catch(() => {
      behaviorPriorityCache.delete(cacheKey);
      return null;
    });

  behaviorPriorityCache.set(cacheKey, pending);
  return pending;
}
