// 宠物成长系统类型定义

// 核心属性类型
export type AttributeType = "wisdom" | "focus" | "social" | "vitality" | "bond";

// 属性信息
export interface Attribute {
  type: AttributeType;
  level: number; // 1-20
  currentXp: number;
  requiredXp: number;
}

// 成长状态
export interface PetGrowth {
  level: number; // 1-100
  currentXp: number;
  requiredXp: number;
  attributes: Record<AttributeType, Attribute>;
  achievements: Achievement[];
  dailyTasks: DailyTask[];
  lastDailyReset: number;
}

// 成就类型
export type AchievementCategory = "exploration" | "social" | "growth" | "special";

export interface Achievement {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  condition: AchievementCondition;
  unlocked: boolean;
  unlockedAt?: number;
  reward?: AchievementReward;
}

// 成就条件
export type AchievementCondition =
  | { type: "level_reached"; level: number }
  | { type: "attribute_reached"; attribute: AttributeType; level: number }
  | { type: "total_xp"; amount: number }
  | { type: "consecutive_days"; days: number }
  | { type: "daily_tasks_completed"; count: number }
  | { type: "special_action"; action: string };

// 成就奖励
export interface AchievementReward {
  xp?: number;
  attributeBoost?: { attribute: AttributeType; amount: number };
}

// 每日任务类型
export type DailyTaskType = "interaction" | "growth" | "social" | "special";

export interface DailyTask {
  id: string;
  name: string;
  description: string;
  type: DailyTaskType;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: DailyTaskReward;
}

// 每日任务奖励
export interface DailyTaskReward {
  xp: number;
  attributeBoost?: { attribute: AttributeType; amount: number };
}

// 经验值信息
export interface ExperienceInfo {
  level: number;
  currentXp: number;
  requiredXp: number;
  percentage: number;
}

// 升级回调参数
export interface LevelUpEvent {
  oldLevel: number;
  newLevel: number;
  unlockedAchievements: Achievement[];
}