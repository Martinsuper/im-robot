import React,{ createContext,useContext } from "react";
import {
GrowthSnapshot,
InteractionManager,
type HumanInteractionEvent,
type PetBehaviorPriority,
type PetBehaviorProfile,
type PetMotionStyle
} from "../interaction";
import {
BehaviorSystem,
PersonalityDimensions,
PersonalityManager
} from "../personality";


export type BondTier = "new" | "warm" | "trusted" | "close";

export function getBondTier(snapshot: GrowthSnapshot): BondTier {
  if (snapshot.level >= 12 || snapshot.attributeLevels.bond >= 8 || snapshot.intimacy >= 55) return "close";
  if (snapshot.level >= 6 || snapshot.attributeLevels.bond >= 4 || snapshot.intimacy >= 25) return "trusted";
  if (snapshot.level >= 3 || snapshot.attributeLevels.bond >= 2 || snapshot.intimacy >= 10) return "warm";
  return "new";
}

export function getFallbackMotionStyleForBond(tier: BondTier): PetMotionStyle {
  switch (tier) {
    case "close":
      return "lively";
    case "trusted":
      return "balanced";
    case "warm":
      return "soft";
    default:
      return "soft";
  }
}

export function getFallbackBehaviorProfileForBond(tier: BondTier): PetBehaviorProfile {
  switch (tier) {
    case "close":
      return "playful";
    case "trusted":
      return "balanced";
    case "warm":
      return "curious";
    default:
      return "calm";
  }
}

export function getFallbackBehaviorPriorityForBond(tier: BondTier): PetBehaviorPriority {
  switch (tier) {
    case "close":
      return ["playful", "curious", "balanced", "focused", "calm", "neutral"];
    case "trusted":
      return ["balanced", "playful", "curious", "focused", "calm", "neutral"];
    case "warm":
      return ["curious", "balanced", "playful", "focused", "calm", "neutral"];
    default:
      return ["calm", "balanced", "curious", "focused", "playful", "neutral"];
  }
}

export interface PetDomainContextValue {
  // 状态
  growthSnapshot: GrowthSnapshot;
  personalitySnapshot: PersonalityDimensions;
  motionStyle: PetMotionStyle;
  behaviorProfile: PetBehaviorProfile;
  behaviorPriority: PetBehaviorPriority;

  // 派生值
  bondTier: BondTier;
  personalitySummary: string;

  // Managers（只读访问）
  interactionManager: InteractionManager;
  personalityManager: PersonalityManager;
  behaviorSystem: BehaviorSystem;

  // 更新函数
  updateGrowth: (event: HumanInteractionEvent) => void;
  recordInteraction: (signal: Parameters<PersonalityManager["recordInteraction"]>[0]) => void;
  evaluateBehavior: () => void;

  // AI 解析触发
  triggerAiRevision: () => void;
}

export const PetDomainContext = createContext<PetDomainContextValue | null>(null);

export interface PetDomainProviderProps {
  children: React.ReactNode;
}


export function usePetDomain(): PetDomainContextValue {
  const context = useContext(PetDomainContext);
  if (!context) {
    throw new Error("usePetDomain must be used within a PetDomainProvider");
  }
  return context;
}


// 导出辅助函数和类型
