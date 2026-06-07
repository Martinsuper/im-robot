// 成长管理器 - 核心入口
import type {
  PetGrowth,
  AttributeType,
  Attribute,
  ExperienceInfo,
  LevelUpEvent,
  Achievement,
  DailyTask,
} from "./growthTypes";
import { ExperienceSystem } from "./ExperienceSystem";
import { AttributeSystem } from "./AttributeSystem";
import { AchievementSystem } from "./AchievementSystem";
import { DailyTaskSystem } from "./DailyTaskSystem";

// 默认初始成长状态
const DEFAULT_GROWTH: PetGrowth = {
  level: 1,
  currentXp: 0,
  requiredXp: ExperienceSystem.getRequiredXp(1),
  attributes: AttributeSystem.initializeAttributes(),
  achievements: [],
  dailyTasks: [],
  lastDailyReset: Date.now(),
};

export class GrowthManager {
  private growth: PetGrowth;
  private achievementSystem: AchievementSystem;
  private dailyTaskSystem: DailyTaskSystem;
  private onLevelUp?: (event: LevelUpEvent) => void;
  private onAchievementUnlocked?: (achievement: Achievement) => void;

  constructor(initialGrowth?: Partial<PetGrowth>) {
    this.growth = { ...DEFAULT_GROWTH, ...initialGrowth };

    // 初始化子系统
    this.achievementSystem = new AchievementSystem(this.growth.achievements);
    this.dailyTaskSystem = new DailyTaskSystem();

    // 初始化每日任务
    if (this.growth.dailyTasks.length === 0) {
      this.growth.dailyTasks = this.dailyTaskSystem.generateDailyTasks();
    }
  }

  /**
   * 设置升级回调
   */
  setOnLevelUp(callback: (event: LevelUpEvent) => void): void {
    this.onLevelUp = callback;
  }

  /**
   * 设置成就解锁回调
   */
  setOnAchievementUnlocked(callback: (achievement: Achievement) => void): void {
    this.onAchievementUnlocked = callback;
  }

  /**
   * 获取当前等级
   */
  getLevel(): number {
    return this.growth.level;
  }

  /**
   * 获取所有属性
   */
  getAttributes(): Record<AttributeType, Attribute> {
    return { ...this.growth.attributes };
  }

  /**
   * 获取单个属性
   */
  getAttribute(type: AttributeType): Attribute {
    return { ...this.growth.attributes[type] };
  }

  /**
   * 获取经验值信息
   */
  getExperienceInfo(): ExperienceInfo {
    return ExperienceSystem.getExperienceInfo(this.growth);
  }

  /**
   * 添加经验值
   */
  addExperience(xp: number): void {
    const result = ExperienceSystem.addExperience(this.growth, xp);
    this.growth = result.growth;

    // 处理升级事件
    if (result.levelUps.length > 0) {
      // 检查成就
      const newAchievements = this.achievementSystem.checkAchievements(this.growth);
      result.levelUps.forEach((levelUp) => {
        levelUp.unlockedAchievements = newAchievements;
      });

      // 触发回调
      if (this.onLevelUp) {
        result.levelUps.forEach((levelUp) => {
          this.onLevelUp!(levelUp);
        });
      }

      // 自动分配属性点
      this.growth = AttributeSystem.autoAssignAttributes(
        this.growth,
        result.levelUps.length * 5
      );
    }

    // 检查成就
    this.checkAchievements();
  }

  /**
   * 为属性添加经验值
   */
  addAttributeXp(attributeType: AttributeType, xp: number): void {
    this.growth = AttributeSystem.addXp(this.growth, attributeType, xp);
    this.checkAchievements();
  }

  /**
   * 获取属性等级
   */
  getAttributeLevel(attributeType: AttributeType): number {
    return AttributeSystem.getLevel(this.growth, attributeType);
  }

  /**
   * 检查成就
   */
  checkAchievements(): Achievement[] {
    const newAchievements = this.achievementSystem.checkAchievements(this.growth);

    // 触发成就解锁回调
    if (this.onAchievementUnlocked && newAchievements.length > 0) {
      newAchievements.forEach((achievement) => {
        this.onAchievementUnlocked!(achievement);
      });
    }

    // 更新成长状态中的成就列表
    this.growth.achievements = this.achievementSystem.getAchievements();

    return newAchievements;
  }

  /**
   * 获取所有成就
   */
  getAchievements(): Achievement[] {
    return this.achievementSystem.getAchievements();
  }

  /**
   * 获取每日任务
   */
  getDailyTasks(): DailyTask[] {
    const tasks = this.dailyTaskSystem.getTasks(this.growth);

    // 如果需要重置，更新状态
    if (this.dailyTaskSystem.shouldReset(this.growth.lastDailyReset)) {
      this.growth.dailyTasks = tasks;
      this.growth.lastDailyReset = Date.now();
    }

    return [...this.growth.dailyTasks];
  }

  /**
   * 更新任务进度
   */
  updateTaskProgress(taskType: string, amount: number = 1): void {
    this.growth = this.dailyTaskSystem.updateProgress(
      this.growth,
      taskType as any,
      amount
    );

    // 检查成就
    this.checkAchievements();
  }

  /**
   * 领取任务奖励
   */
  claimTaskReward(taskId: string): boolean {
    const task = this.growth.dailyTasks.find(
      (t) => t.id === taskId && t.completed && !t.claimed
    );

    if (!task) return false;

    this.growth = this.dailyTaskSystem.claimReward(this.growth, taskId);

    // 应用奖励
    this.addExperience(task.reward.xp);
    if (task.reward.attributeBoost) {
      this.addAttributeXp(
        task.reward.attributeBoost.attribute,
        task.reward.attributeBoost.amount
      );
    }

    return true;
  }

  /**
   * 获取任务完成进度
   */
  getTaskProgress(): { total: number; completed: number } {
    return this.dailyTaskSystem.getTaskProgress(this.growth);
  }

  /**
   * 获取完整成长状态
   */
  getGrowthState(): PetGrowth {
    return { ...this.growth };
  }

  /**
   * 加载成长状态（从存储恢复）
   */
  loadGrowthState(state: PetGrowth): void {
    this.growth = { ...state };
    this.achievementSystem = new AchievementSystem(this.growth.achievements);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    level: number;
    totalXp: number;
    attributeLevels: Record<AttributeType, number>;
    unlockedAchievements: number;
    completedTasks: number;
  } {
    // 计算总经验值
    let totalXp = this.growth.currentXp;
    for (let i = 1; i < this.growth.level; i++) {
      totalXp += Math.floor(100 * i * 1.15);
    }

    return {
      level: this.growth.level,
      totalXp,
      attributeLevels: {
        wisdom: this.growth.attributes.wisdom.level,
        focus: this.growth.attributes.focus.level,
        social: this.growth.attributes.social.level,
        vitality: this.growth.attributes.vitality.level,
        bond: this.growth.attributes.bond.level,
      },
      unlockedAchievements: this.achievementSystem.getUnlockedAchievements().length,
      completedTasks: this.growth.dailyTasks.filter((t) => t.completed).length,
    };
  }
}