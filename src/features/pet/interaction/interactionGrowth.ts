import { readPersistentState, writePersistentState } from "../../../lib/persistentState";
import {
  GrowthManager,
  type AttributeType,
  type PetGrowth,
} from "../growth";
import { loadInteractionStats } from "./interactionStorage";
import type { HumanInteractionEvent } from "./interactionTypes";

const GROWTH_STORAGE_KEY = "piko-pet-growth-state";

export interface GrowthSnapshot {
  level: number;
  currentXp: number;
  requiredXp: number;
  percentage: number;
  totalXp: number;
  attributeLevels: Record<AttributeType, number>;
  unlockedAchievements: number;
  completedTasks: number;
  taskProgress: { total: number; completed: number };
  intimacy: number;
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function createDefaultGrowth(): PetGrowth {
  return new GrowthManager().getGrowthState();
}

export function loadGrowthState(): PetGrowth {
  if (!canUseStorage()) return createDefaultGrowth();

  try {
    const raw = readPersistentState(GROWTH_STORAGE_KEY);
    if (!raw) return createDefaultGrowth();
    return { ...createDefaultGrowth(), ...JSON.parse(raw) } as PetGrowth;
  } catch (error) {
    // 降级为默认值，不打扰用户：成长状态每次挂载都读一次，
    // 失败时弹窗会持续骚扰，且只是丢失进度展示，不影响核心功能。
    console.warn("[interactionGrowth] 读取失败", error);
    return createDefaultGrowth();
  }
}

export function saveGrowthState(state: PetGrowth): void {
  if (!canUseStorage()) return;
  try {
    writePersistentState(GROWTH_STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent<PetGrowth>("piko-growth-state-changed", { detail: state }));
  } catch (error) {
    // ignore persistence failures。
    // 降级为「本次不持久化」，不打扰用户：每次交互都会写一次，弹窗会刷屏。
    console.warn("[interactionGrowth] 写入失败", error);
  }
}

export function loadGrowthSnapshot(): GrowthSnapshot {
  const manager = new GrowthManager(loadGrowthState());
  const experience = manager.getExperienceInfo();
  const stats = manager.getStats();
  return {
    level: stats.level,
    currentXp: experience.currentXp,
    requiredXp: experience.requiredXp,
    percentage: experience.percentage,
    totalXp: stats.totalXp,
    attributeLevels: stats.attributeLevels,
    unlockedAchievements: stats.unlockedAchievements,
    completedTasks: stats.completedTasks,
    taskProgress: manager.getTaskProgress(),
    intimacy: loadInteractionStats().intimacy,
  };
}

function awardInteractionGrowth(manager: GrowthManager, event: HumanInteractionEvent) {
  switch (event.type) {
    case "click":
      manager.addExperience(2);
      manager.addAttributeXp("bond", 8);
      manager.updateTaskProgress("interaction", 1);
      break;
    case "double_click":
      manager.addExperience(3);
      manager.addAttributeXp("bond", 10);
      break;
    case "hover":
      manager.addExperience(1);
      manager.addAttributeXp("wisdom", 4);
      break;
    case "pet_stroke":
      manager.addExperience(4);
      manager.addAttributeXp("bond", 15);
      manager.addAttributeXp("social", 8);
      manager.updateTaskProgress("interaction", 1);
      break;
    case "drag_end":
      manager.addExperience(2);
      manager.addAttributeXp("vitality", 6);
      break;
    case "drop_file":
      manager.addExperience(5);
      manager.addAttributeXp("social", 12);
      manager.updateTaskProgress("social", 1);
      break;
    case "drop_text":
      manager.addExperience(2);
      manager.addAttributeXp("wisdom", 8);
      break;
    case "chat_open":
    case "chat_submitted":
      manager.addExperience(1);
      manager.addAttributeXp("social", 4);
      break;
    case "chat_completed":
      manager.addExperience(6);
      manager.addAttributeXp("social", 14);
      manager.updateTaskProgress("social", 1);
      break;
    case "focus_started":
      manager.addAttributeXp("focus", 4);
      break;
    case "focus_completed":
      manager.addExperience(5);
      manager.addAttributeXp("focus", 12);
      manager.updateTaskProgress("growth", 1);
      break;
    default:
      break;
  }
}

export function applyInteractionGrowth(event: HumanInteractionEvent): GrowthSnapshot {
  const manager = new GrowthManager(loadGrowthState());
  awardInteractionGrowth(manager, event);
  const nextState = manager.getGrowthState();
  saveGrowthState(nextState);
  const experience = manager.getExperienceInfo();
  const stats = manager.getStats();
  return {
    level: stats.level,
    currentXp: experience.currentXp,
    requiredXp: experience.requiredXp,
    percentage: experience.percentage,
    totalXp: stats.totalXp,
    attributeLevels: stats.attributeLevels,
    unlockedAchievements: stats.unlockedAchievements,
    completedTasks: stats.completedTasks,
    taskProgress: manager.getTaskProgress(),
    intimacy: loadInteractionStats().intimacy,
  };
}
