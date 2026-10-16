import { useEffect,useMemo,useRef,useState } from "react";
import { useAsyncResolved } from "../hooks/useAsyncResolved";
import {
applyInteractionGrowth,
GrowthSnapshot,
InteractionManager,
loadGrowthSnapshot,
loadInteractionStats,
resolvePetBehaviorPriority,
resolvePetBehaviorProfile,
resolvePetIdleMotionStyle,
storeInteractionStats,
type HumanInteractionEvent,
} from "../interaction";
import {
BehaviorSystem,
derivePersonalityFromSignals,
describePersonality,
loadPersonalityState,
PersonalityDimensions,
PersonalityManager,
} from "../personality";
import { getBondTier,getFallbackBehaviorPriorityForBond,getFallbackBehaviorProfileForBond,getFallbackMotionStyleForBond,PetDomainContext,PetDomainContextValue,PetDomainProviderProps } from "./PetDomainContextData";


export function PetDomainProvider({ children }: PetDomainProviderProps) {
  // 初始化 managers（使用 useMemo lazy init）
  const interactionManager = useMemo(() => new InteractionManager(), []);
  const personalityManager = useMemo(() => new PersonalityManager(loadPersonalityState()), []);
  const behaviorSystemRef = useRef<BehaviorSystem | null>(null);

  // 初始状态
  const [growthSnapshot] = useState<GrowthSnapshot>(() => loadGrowthSnapshot());
  const [personalitySnapshot] = useState<PersonalityDimensions>(() => {
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

  // 初始化 behaviorSystem（在 refs 中，因为需要在 effect 中启动/停止）
  const behaviorSystem = useMemo(() => {
    const system = new BehaviorSystem(personalityManager);
    return system;
  }, [personalityManager]);

  useEffect(() => { behaviorSystemRef.current = behaviorSystem; }, [behaviorSystem]);

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
    return (signal: Parameters<PersonalityManager["recordInteraction"]>[0]) => {
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

  // 监听 storage 事件和自定义事件刷新状态
  useEffect(() => {
    const handleStorageChange = () => {
      // 当 storage 变化时，重新加载状态
      // 这里不直接设置 state，因为 PetDomainContext 不负责管理完整状态同步
      // 主要由外部组件或 storage 事件驱动
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("piko-interaction-stats-changed", handleStorageChange as EventListener);
    window.addEventListener("piko-growth-state-changed", handleStorageChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("piko-interaction-stats-changed", handleStorageChange as EventListener);
      window.removeEventListener("piko-growth-state-changed", handleStorageChange as EventListener);
    };
  }, []);

  // 在 behaviorSystem 上设置回调并启动/停止
  useEffect(() => {
    const system = behaviorSystemRef.current;
    if (!system) return;

    // 设置行为触发回调
    system.setOnTrigger((event) => {
      console.debug("[PetDomainContext] Behavior triggered:", event);
    });

    // 启动 behaviorSystem
    system.start();

    return () => {
      system.stop();
    };
  }, []);

  // 当 behaviorProfile 和 behaviorPriority 解析完成后，更新到 behaviorSystem
  useEffect(() => {
    const system = behaviorSystemRef.current;
    if (!system) return;
    system.setBehaviorProfile(behaviorProfile);
    system.setBehaviorPriority(behaviorPriority);
  }, [behaviorProfile, behaviorPriority]);

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
