// 经验值系统
import type { ExperienceInfo, LevelUpEvent, PetGrowth } from "./growthTypes";

// 升级公式：下一等级所需经验 = 基础值(100) × 当前等级 × 1.15
const BASE_XP = 100;
const XP_MULTIPLIER = 1.15;

export class ExperienceSystem {
  /**
   * 计算指定等级所需的升级经验
   */
  static getRequiredXp(level: number): number {
    return Math.floor(BASE_XP * level * XP_MULTIPLIER);
  }

  /**
   * 获取当前经验值信息
   */
  static getExperienceInfo(growth: PetGrowth): ExperienceInfo {
    const requiredXp = this.getRequiredXp(growth.level);
    const percentage = Math.min((growth.currentXp / requiredXp) * 100, 100);

    return {
      level: growth.level,
      currentXp: growth.currentXp,
      requiredXp,
      percentage,
    };
  }

  /**
   * 添加经验值并检测升级
   */
  static addExperience(
    growth: PetGrowth,
    xp: number
  ): { growth: PetGrowth; levelUps: LevelUpEvent[] } {
    const levelUps: LevelUpEvent[] = [];
    let currentXp = growth.currentXp + xp;
    let currentLevel = growth.level;

    // 检测连续升级
    while (currentLevel < 100) {
      const requiredXp = this.getRequiredXp(currentLevel);
      if (currentXp >= requiredXp) {
        const oldLevel = currentLevel;
        currentLevel++;
        currentXp -= requiredXp;

        const levelUpEvent: LevelUpEvent = {
          oldLevel,
          newLevel: currentLevel,
          unlockedAchievements: [],
        };
        levelUps.push(levelUpEvent);
      } else {
        break;
      }
    }

    // 确保经验不超过上限
    if (currentLevel >= 100) {
      currentXp = 0;
    }

    const updatedGrowth: PetGrowth = {
      ...growth,
      level: currentLevel,
      currentXp,
    };

    return { growth: updatedGrowth, levelUps };
  }

  /**
   * 根据任务类型获取经验值倍率
   */
  static getXpMultiplier(taskType: string): number {
    const multipliers: Record<string, number> = {
      interaction: 1.0,
      growth: 1.2,
      social: 0.8,
      special: 1.5,
    };
    return multipliers[taskType] || 1.0;
  }
}