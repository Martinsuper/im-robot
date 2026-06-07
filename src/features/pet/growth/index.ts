// 成长系统导出
export { GrowthManager } from "./GrowthManager";
export { ExperienceSystem } from "./ExperienceSystem";
export { AttributeSystem, ATTRIBUTE_NAMES } from "./AttributeSystem";
export { AchievementSystem } from "./AchievementSystem";
export { DailyTaskSystem } from "./DailyTaskSystem";

// 导出类型
export type {
  PetGrowth,
  Attribute,
  AttributeType,
  Achievement,
  AchievementCategory,
  AchievementCondition,
  AchievementReward,
  DailyTask,
  DailyTaskType,
  DailyTaskReward,
  ExperienceInfo,
  LevelUpEvent,
} from "./growthTypes";