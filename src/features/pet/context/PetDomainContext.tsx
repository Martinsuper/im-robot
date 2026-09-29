import React, { createContext, useContext, useMemo, useState, useEffect } from "react";
import {
  GrowthSnapshot,
  loadGrowthSnapshot,
  loadInteractionStats,
  storeInteractionStats,
  applyInteractionGrowth,
  type HumanInteractionEvent,
} from "../interaction";
import {
  PersonalityDimensions,
  PersonalityManager,
  describePersonality,
  derivePersonalityFromSignals,
  loadPersonalityState,
} from "../personality";
import { BehaviorSystem } from "../personality";
import {
  resolvePetIdleMotionStyle,
  resolvePetBehaviorProfile,
  resolvePetBehaviorPriority,
  type PetMotionStyle,
  type PetBehaviorProfile,
  type PetBehaviorPriority,
} from "../interaction";
import { useAsyncResolved } from "../hooks/useAsyncResolved";
import { InteractionManager } from "../interaction";

export type BondTier = "new" | "warm" | "trusted" | "close";

function getBondTier(snapshot: GrowthSnapshot): BondTier {
  if (snapshot.level >= 12 || snapshot.attributeLevels.bond >= 8 || snapshot.intimacy >= 55) return "close";
  if (snapshot.level >= 6 || snapshot.attributeLevels.bond >= 4 || snapshot.intimacy >= 25) return "trusted";
  if (snapshot.level >= 3 || snapshot.attributeLevels.bond >= 2 || snapshot.intimacy >= 10) return "warm";
  return "new";
}

function getFallbackMotionStyleForBond(tier: BondTier): PetMotionStyle {
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

function getFallbackBehaviorProfileForBond(tier: BondTier): PetBehaviorProfile {
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

function getFallbackBehaviorPriorityForBond(tier: BondTier): PetBehaviorPriority {
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

interface PetDomainContextValue {
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
  recordInteraction: (signal: any) => void;
  evaluateBehavior: () => void;

  // AI 解析触发
  triggerAiRevision: () => void;
}

const PetDomainContext = createContext<PetDomainContextValue | null>(null);

interface PetDomainProviderProps {
  children: React.ReactNode;
}

export function PetDomainProvider({ children }: PetDomainProviderProps) {
  // 初始化 managers（使用 useMemo lazy init）
  const interactionManager = useMemo(() => new InteractionManager(), []);
  const personalityManager = useMemo(() => new PersonalityManager(loadPersonalityState()), []);

  // 初始状态
  const [growthSnapshot, setGrowthSnapshot] = useState<GrowthSnapshot>(() => loadGrowthSnapshot());
  const [personalitySnapshot, setPersonalitySnapshot] = useState<PersonalityDimensions>(() => {
    const stats = loadInteractionStats();
    const growth = loadGrowthSnapshot();
    return derivePersonalityFromSignals(stats, growth);
  });

  // 派生值
  const bondTier = useMemo(() => getBondTier(growthSnapshot), [growthSnapshot]);
  const personalitySummary = useMemo(
    () => describePersonality(personalitySnapshot),
    [personalitySnapshot]
  );

  // fallback 值
  const fallbackMotionStyle = useMemo(
    () => getFallbackMotionStyleForBond(bondTier),
    [bondTier]
  );
  const fallbackBehaviorProfile = useMemo(
    () => getFallbackBehaviorProfileForBond(bondTier),
    [bondTier]
  );
  const fallbackBehaviorPriority = useMemo(
    () => getFallbackBehaviorPriorityForBond(bondTier),
    [bondTier]
  );

  // AI 解析（使用 useAsyncResolved）
  const motionStyle = useAsyncResolved(
    fallbackMotionStyle,
    [bondTier, personalitySnapshot.energy, personalitySnapshot.humor, personalitySnapshot.curiosity, personalitySummary] as const,
    async (bt, e, h, c, ps) => {
      const result = await resolvePetIdleMotionStyle({
        bondTier: bt,
        personality: { energy: e, humor: h, curiosity: c },
        personalitySummary: ps,
      });
      return result ?? undefined;
    }
  );

  const behaviorProfile = useAsyncResolved(
    fallbackBehaviorProfile,
    [bondTier, personalitySnapshot.energy, personalitySnapshot.humor, personalitySnapshot.curiosity, personalitySummary] as const,
    async (bt, e, h, c, ps) => {
      const result = await resolvePetBehaviorProfile({
        bondTier: bt,
        personality: { energy: e, humor: h, curiosity: c },
        personalitySummary: ps,
      });
      return result ?? undefined;
    }
  );

  const behaviorPriority = useAsyncResolved(
    fallbackBehaviorPriority,
    [bondTier, personalitySnapshot.energy, personalitySnapshot.humor, personalitySnapshot.curiosity, personalitySummary] as const,
    async (bt, e, h, c, ps) => {
      const result = await resolvePetBehaviorPriority({
        bondTier: bt,
        personality: { energy: e, humor: h, curiosity: c },
        personalitySummary: ps,
      });
      return result ?? undefined;
    }
  );

  // 初始化 behaviorSystem（useState 惰性初始化保证渲染期纯净；
  // system 需要在 effect 中启动/停止，实例本身生命周期与 Provider 一致）
  const [behaviorSystem] = useState(() => new BehaviorSystem(personalityManager));

  // AI revision 计数（用于触发重新解析）
  const [, setAiRevision] = useState(0);

  // 更新函数
  const updateGrowth = useMemo(() => {
    return (event: HumanInteractionEvent) => {
      storeInteractionStats(event);
      applyInteractionGrowth(event);
    };
  }, []);

  const recordInteraction = useMemo(() => {
    return (signal: any) => {
      personalityManager.recordInteraction(signal);
    };
  }, [personalityManager]);

  const evaluateBehavior = useMemo(() => {
    return () => {
      behaviorSystem.evaluateNow();
    };
  }, [behaviorSystem]);

  const triggerAiRevision = useMemo(() => {
    return () => {
      setAiRevision((prev) => prev + 1);
    };
  }, []);

  // 监听 storage 事件和自定义事件刷新状态。
  // 快照必须在事件后更新，否则 bondTier 等派生值会永远停留在挂载时的值。
  useEffect(() => {
    const refreshFromStorage = () => {
      const growth = loadGrowthSnapshot();
      setGrowthSnapshot(growth);
      setPersonalitySnapshot(derivePersonalityFromSignals(loadInteractionStats(), growth));
    };

    window.addEventListener("storage", refreshFromStorage);
    window.addEventListener("piko-interaction-stats-changed", refreshFromStorage as EventListener);
    window.addEventListener("piko-growth-state-changed", refreshFromStorage as EventListener);

    return () => {
      window.removeEventListener("storage", refreshFromStorage);
      window.removeEventListener("piko-interaction-stats-changed", refreshFromStorage as EventListener);
      window.removeEventListener("piko-growth-state-changed", refreshFromStorage as EventListener);
    };
  }, []);

  // 在 behaviorSystem 上设置回调并启动/停止
  useEffect(() => {
    // 设置行为触发回调
    behaviorSystem.setOnTrigger((event) => {
      console.debug("[PetDomainContext] Behavior triggered:", event);
    });

    // 启动 behaviorSystem
    behaviorSystem.start();

    return () => {
      behaviorSystem.stop();
    };
  }, [behaviorSystem]);

  // 当 behaviorProfile 和 behaviorPriority 解析完成后，更新到 behaviorSystem
  useEffect(() => {
    behaviorSystem.setBehaviorProfile(behaviorProfile);
    behaviorSystem.setBehaviorPriority(behaviorPriority);
  }, [behaviorSystem, behaviorProfile, behaviorPriority]);

  const contextValue = useMemo<PetDomainContextValue>(
    () => ({
      // 状态
      growthSnapshot,
      personalitySnapshot,
      motionStyle,
      behaviorProfile,
      behaviorPriority,

      // 派生值
      bondTier,
      personalitySummary,

      // Managers
      interactionManager,
      personalityManager,
      behaviorSystem,

      // 更新函数
      updateGrowth,
      recordInteraction,
      evaluateBehavior,

      // AI 解析触发
      triggerAiRevision,
    }),
    [
      growthSnapshot,
      personalitySnapshot,
      motionStyle,
      behaviorProfile,
      behaviorPriority,
      bondTier,
      personalitySummary,
      interactionManager,
      personalityManager,
      behaviorSystem,
      updateGrowth,
      recordInteraction,
      evaluateBehavior,
      triggerAiRevision,
    ]
  );

  return (
    <PetDomainContext.Provider value={contextValue}>
      {children}
    </PetDomainContext.Provider>
  );
}

export function usePetDomain(): PetDomainContextValue {
  const context = useContext(PetDomainContext);
  if (!context) {
    throw new Error("usePetDomain must be used within a PetDomainProvider");
  }
  return context;
}

// 导出辅助函数和类型
export { getBondTier, getFallbackMotionStyleForBond, getFallbackBehaviorProfileForBond, getFallbackBehaviorPriorityForBond };
