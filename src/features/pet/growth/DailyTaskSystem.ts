// 每日任务系统
import type {
  DailyTask,
  DailyTaskType,
  DailyTaskReward,
  PetGrowth,
} from "./growthTypes";

// 任务模板
interface TaskTemplate {
  name: string;
  description: string;
  type: DailyTaskType;
  target: number;
  reward: DailyTaskReward;
}

// 默认任务模板
const DEFAULT_TASK_TEMPLATES: TaskTemplate[] = [
  {
    name: "日常互动",
    description: "与宠物互动5次",
    type: "interaction",
    target: 5,
    reward: { xp: 20 },
  },
  {
    name: "对话交流",
    description: "与宠物对话3次",
    type: "interaction",
    target: 3,
    reward: { xp: 30 },
  },
  {
    name: "属性修炼",
    description: "提升任意属性1级",
    type: "growth",
    target: 1,
    reward: { xp: 40, attributeBoost: { attribute: "wisdom", amount: 5 } },
  },
  {
    name: "专注训练",
    description: "完成专注训练",
    type: "growth",
    target: 1,
    reward: { xp: 35, attributeBoost: { attribute: "focus", amount: 5 } },
  },
  {
    name: "社交活动",
    description: "参与社交活动2次",
    type: "social",
    target: 2,
    reward: { xp: 25, attributeBoost: { attribute: "social", amount: 3 } },
  },
  {
    name: "活力运动",
    description: "进行活力运动",
    type: "growth",
    target: 1,
    reward: { xp: 30, attributeBoost: { attribute: "vitality", amount: 5 } },
  },
  {
    name: "羁绊培养",
    description: "与宠物建立羁绊",
    type: "social",
    target: 1,
    reward: { xp: 35, attributeBoost: { attribute: "bond", amount: 5 } },
  },
  {
    name: "特别任务",
    description: "完成特别挑战",
    type: "special",
    target: 1,
    reward: { xp: 50 },
  },
];

export class DailyTaskSystem {
  private templates: TaskTemplate[];

  constructor(templates?: TaskTemplate[]) {
    this.templates = templates || [...DEFAULT_TASK_TEMPLATES];
  }

  /**
   * 生成每日任务（随机选择3个）
   */
  generateDailyTasks(): DailyTask[] {
    const shuffled = [...this.templates].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 3);

    return selected.map((template, index) => ({
      id: `daily_${Date.now()}_${index}`,
      name: template.name,
      description: template.description,
      type: template.type,
      target: template.target,
      progress: 0,
      completed: false,
      claimed: false,
      reward: template.reward,
    }));
  }

  /**
   * 检查是否需要重置每日任务
   */
  shouldReset(lastResetTime: number): boolean {
    const lastReset = new Date(lastResetTime);
    const now = new Date();

    // 检查是否是新的一天
    return (
      lastReset.getFullYear() !== now.getFullYear() ||
      lastReset.getMonth() !== now.getMonth() ||
      lastReset.getDate() !== now.getDate()
    );
  }

  /**
   * 获取今日任务列表
   */
  getTasks(growth: PetGrowth): DailyTask[] {
    // 检查是否需要重置
    if (this.shouldReset(growth.lastDailyReset)) {
      return this.generateDailyTasks();
    }
    return growth.dailyTasks;
  }

  /**
   * 更新任务进度
   */
  updateProgress(
    growth: PetGrowth,
    taskType: DailyTaskType,
    amount: number = 1
  ): PetGrowth {
    const tasks = [...growth.dailyTasks];
    let hasChanges = false;

    for (const task of tasks) {
      if (task.type === taskType && !task.completed) {
        task.progress = Math.min(task.progress + amount, task.target);
        if (task.progress >= task.target) {
          task.completed = true;
        }
        hasChanges = true;
      }
    }

    if (!hasChanges) {
      return growth;
    }

    return {
      ...growth,
      dailyTasks: tasks,
    };
  }

  /**
   * 领取任务奖励
   */
  claimReward(growth: PetGrowth, taskId: string): PetGrowth {
    const tasks = growth.dailyTasks.map((task) => {
      if (task.id === taskId && task.completed && !task.claimed) {
        return { ...task, claimed: true };
      }
      return task;
    });

    return {
      ...growth,
      dailyTasks: tasks,
    };
  }

  /**
   * 获取已完成但未领取奖励的任务数
   */
  getClaimableTasks(growth: PetGrowth): number {
    return growth.dailyTasks.filter((t) => t.completed && !t.claimed).length;
  }

  /**
   * 获取任务完成进度
   */
  getTaskProgress(growth: PetGrowth): { total: number; completed: number } {
    const total = growth.dailyTasks.length;
    const completed = growth.dailyTasks.filter((t) => t.completed).length;
    return { total, completed };
  }

  /**
   * 检查所有任务是否完成
   */
  allTasksCompleted(growth: PetGrowth): boolean {
    return growth.dailyTasks.every((t) => t.completed);
  }
}