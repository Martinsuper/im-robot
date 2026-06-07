// 成就系统
import type {
  Achievement,
  AchievementCategory,
  AchievementCondition,
  PetGrowth,
} from "./growthTypes";

// 默认成就列表
const DEFAULT_ACHIEVEMENTS: Achievement[] = [
  // 探索成就
  {
    id: "first_level_up",
    name: "初次成长",
    description: "宠物达到2级",
    category: "exploration",
    condition: { type: "level_reached", level: 2 },
    unlocked: false,
    reward: { xp: 50 },
  },
  {
    id: "level_10",
    name: "小有成就",
    description: "宠物达到10级",
    category: "exploration",
    condition: { type: "level_reached", level: 10 },
    unlocked: false,
    reward: { xp: 200 },
  },
  {
    id: "level_50",
    name: "资深伙伴",
    description: "宠物达到50级",
    category: "exploration",
    condition: { type: "level_reached", level: 50 },
    unlocked: false,
    reward: { xp: 1000 },
  },
  {
    id: "level_100",
    name: "传奇伙伴",
    description: "宠物达到100级",
    category: "exploration",
    condition: { type: "level_reached", level: 100 },
    unlocked: false,
    reward: { xp: 5000 },
  },

  // 社交成就
  {
    id: "social_butterfly",
    name: "社交蝴蝶",
    description: "社交属性达到5级",
    category: "social",
    condition: { type: "attribute_reached", attribute: "social", level: 5 },
    unlocked: false,
    reward: { attributeBoost: { attribute: "social", amount: 10 } },
  },
  {
    id: "bonded_soul",
    name: "羁绊之魂",
    description: "羁绊属性达到10级",
    category: "social",
    condition: { type: "attribute_reached", attribute: "bond", level: 10 },
    unlocked: false,
    reward: { attributeBoost: { attribute: "bond", amount: 20 } },
  },

  // 成长成就
  {
    id: "wise_sage",
    name: "智慧贤者",
    description: "智慧属性达到15级",
    category: "growth",
    condition: { type: "attribute_reached", attribute: "wisdom", level: 15 },
    unlocked: false,
    reward: { attributeBoost: { attribute: "wisdom", amount: 30 } },
  },
  {
    id: "focus_master",
    name: "专注大师",
    description: "专注属性达到15级",
    category: "growth",
    condition: { type: "attribute_reached", attribute: "focus", level: 15 },
    unlocked: false,
    reward: { attributeBoost: { attribute: "focus", amount: 30 } },
  },
  {
    id: "vital_vigor",
    name: "活力四射",
    description: "活力属性达到15级",
    category: "growth",
    condition: { type: "attribute_reached", attribute: "vitality", level: 15 },
    unlocked: false,
    reward: { attributeBoost: { attribute: "vitality", amount: 30 } },
  },

  // 特殊成就
  {
    id: "daily_devotee",
    name: "每日坚持",
    description: "连续7天完成每日任务",
    category: "special",
    condition: { type: "consecutive_days", days: 7 },
    unlocked: false,
    reward: { xp: 500 },
  },
  {
    id: "task_master",
    name: "任务达人",
    description: "完成100个每日任务",
    category: "special",
    condition: { type: "daily_tasks_completed", count: 100 },
    unlocked: false,
    reward: { xp: 1000 },
  },
];

export class AchievementSystem {
  private achievements: Achievement[];

  constructor(achievements?: Achievement[]) {
    this.achievements = achievements || [...DEFAULT_ACHIEVEMENTS];
  }

  /**
   * 获取所有成就
   */
  getAchievements(): Achievement[] {
    return [...this.achievements];
  }

  /**
   * 获取已解锁的成就
   */
  getUnlockedAchievements(): Achievement[] {
    return this.achievements.filter((a) => a.unlocked);
  }

  /**
   * 获取未解锁的成就
   */
  getLockedAchievements(): Achievement[] {
    return this.achievements.filter((a) => !a.unlocked);
  }

  /**
   * 检查单个成就条件
   */
  private checkCondition(
    condition: AchievementCondition,
    growth: PetGrowth
  ): boolean {
    switch (condition.type) {
      case "level_reached":
        return growth.level >= condition.level;

      case "attribute_reached":
        return growth.attributes[condition.attribute].level >= condition.level;

      case "total_xp": {
        // 计算总经验值（当前经验 + 已消耗经验）
        let totalXp = growth.currentXp;
        for (let i = 1; i < growth.level; i++) {
          totalXp += Math.floor(100 * i * 1.15);
        }
        return totalXp >= condition.amount;
      }

      case "consecutive_days":
        // 需要外部系统提供连续天数
        return false;

      case "daily_tasks_completed": {
        const completedTasks = growth.dailyTasks.filter((t) => t.completed).length;
        return completedTasks >= condition.count;
      }

      case "special_action":
        // 特殊动作需要外部系统触发
        return false;

      default:
        return false;
    }
  }

  /**
   * 检查所有成就并返回新解锁的成就
   */
  checkAchievements(growth: PetGrowth): Achievement[] {
    const newlyUnlocked: Achievement[] = [];

    for (const achievement of this.achievements) {
      if (achievement.unlocked) continue;

      if (this.checkCondition(achievement.condition, growth)) {
        achievement.unlocked = true;
        achievement.unlockedAt = Date.now();
        newlyUnlocked.push(achievement);
      }
    }

    return newlyUnlocked;
  }

  /**
   * 手动解锁成就
   */
  unlockAchievement(achievementId: string): boolean {
    const achievement = this.achievements.find((a) => a.id === achievementId);
    if (achievement && !achievement.unlocked) {
      achievement.unlocked = true;
      achievement.unlockedAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * 获取成就进度
   */
  getAchievementProgress(achievementId: string, growth: PetGrowth): number {
    const achievement = this.achievements.find((a) => a.id === achievementId);
    if (!achievement) return 0;
    if (achievement.unlocked) return 100;

    const condition = achievement.condition;
    switch (condition.type) {
      case "level_reached":
        return Math.min((growth.level / condition.level) * 100, 100);

      case "attribute_reached":
        return Math.min(
          (growth.attributes[condition.attribute].level / condition.level) * 100,
          100
        );

      case "total_xp": {
        let totalXp = growth.currentXp;
        for (let i = 1; i < growth.level; i++) {
          totalXp += Math.floor(100 * i * 1.15);
        }
        return Math.min((totalXp / condition.amount) * 100, 100);
      }

      case "daily_tasks_completed": {
        const completedTasks = growth.dailyTasks.filter((t) => t.completed).length;
        return Math.min((completedTasks / condition.count) * 100, 100);
      }

      default:
        return 0;
    }
  }

  /**
   * 按分类获取成就
   */
  getAchievementsByCategory(category: AchievementCategory): Achievement[] {
    return this.achievements.filter((a) => a.category === category);
  }

  /**
   * 重置所有成就（测试用）
   */
  resetAchievements(): void {
    for (const achievement of this.achievements) {
      achievement.unlocked = false;
      achievement.unlockedAt = undefined;
    }
  }
}