/**
 * 心情管理器
 * 管理宠物的持久心情状态
 */

import type {
  MoodType,
  MoodConfig,
  MoodState,
  MoodChangeCallback,
} from "./emotionTypes";
import { MOOD_CONFIGS } from "./emotionTypes";

/**
 * 心情管理器类
 * 负责管理宠物的心情状态和自动触发
 */
export class MoodManager {
  private currentMood: MoodType = "content";
  private moodIntensity: number = 0.5;
  private moodStartTime: number = Date.now();
  private lastInteractionTime: number = Date.now();
  private lastLoginTime: number = Date.now();
  private consecutiveDays: number = 1;
  private moodCallbacks: MoodChangeCallback[] = [];
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 构造函数
   * @param checkIntervalMs 检查间隔 (毫秒, 默认5分钟)
   */
  constructor(checkIntervalMs: number = 5 * 60 * 1000) {
    // 启动自动检查
    this.startAutoCheck(checkIntervalMs);
  }

  /**
   * 设置心情
   * @param mood 目标心情
   * @param intensity 心情强度 (0-1, 默认0.5)
   */
  setMood(mood: MoodType, intensity: number = 0.5): void {
    const oldMood = this.currentMood;

    // 限制强度范围
    const clampedIntensity = Math.max(0, Math.min(1, intensity));

    // 更新心情状态
    this.currentMood = mood;
    this.moodIntensity = clampedIntensity;
    this.moodStartTime = Date.now();

    // 通知回调
    if (oldMood !== mood) {
      this.notifyMoodChange(oldMood, mood, clampedIntensity);
    }
  }

  /**
   * 获取当前心情
   * @returns 当前心情类型
   */
  getMood(): MoodType {
    return this.currentMood;
  }

  /**
   * 获取心情强度
   * @returns 当前心情强度 (0-1)
   */
  getIntensity(): number {
    return this.moodIntensity;
  }

  /**
   * 获取完整的心情状态
   * @returns 心情状态对象
   */
  getMoodState(): MoodState {
    return {
      currentMood: this.currentMood,
      intensity: this.moodIntensity,
      startTime: this.moodStartTime,
      lastInteractionTime: this.lastInteractionTime,
      lastLoginTime: this.lastLoginTime,
      consecutiveDays: this.consecutiveDays,
    };
  }

  /**
   * 获取心情配置
   * @param mood 心情类型
   * @returns 心情配置
   */
  getMoodConfig(mood: MoodType): MoodConfig {
    return MOOD_CONFIGS[mood];
  }

  /**
   * 记录用户交互
   */
  recordInteraction(): void {
    this.lastInteractionTime = Date.now();
  }

  /**
   * 记录用户登录
   */
  recordLogin(): void {
    const now = Date.now();
    const lastLogin = this.lastLoginTime;
    const daysSinceLastLogin = (now - lastLogin) / (24 * 60 * 60 * 1000);

    if (daysSinceLastLogin >= 1) {
      // 更新连续天数
      if (daysSinceLastLogin < 2) {
        // 连续登录
        this.consecutiveDays++;
      } else {
        // 断开连续
        this.consecutiveDays = 1;
      }
    }

    this.lastLoginTime = now;
    this.lastInteractionTime = now;
  }

  /**
   * 检查长时间未交互 (>2小时) → sleepy
   */
  checkNoInteraction(): void {
    const now = Date.now();
    const timeSinceLastInteraction = now - this.lastInteractionTime;
    const twoHoursMs = 2 * 60 * 60 * 1000;

    if (timeSinceLastInteraction >= twoHoursMs) {
      const sleepyConfig = this.getMoodConfig("sleepy");
      if (sleepyConfig.autoTrigger && sleepyConfig.triggerCondition) {
        const intensity = Math.min(1, timeSinceLastInteraction / (twoHoursMs * 2));
        this.setMood("sleepy", intensity);
      }
    }
  }

  /**
   * 检查长时间未登录 (>3天) → missyou
   */
  checkNoLogin(): void {
    const now = Date.now();
    const daysSinceLastLogin = (now - this.lastLoginTime) / (24 * 60 * 60 * 1000);
    const threeDays = 3;

    if (daysSinceLastLogin >= threeDays) {
      const missYouConfig = this.getMoodConfig("missyou");
      if (missYouConfig.autoTrigger && missYouConfig.triggerCondition) {
        const intensity = Math.min(1, daysSinceLastLogin / (threeDays * 2));
        this.setMood("missyou", intensity);
      }
    }
  }

  /**
   * 检查心情触发条件
   */
  checkMoodTriggers(): void {
    this.checkNoInteraction();
    this.checkNoLogin();
  }

  /**
   * 添加心情变化回调
   * @param callback 回调函数
   */
  onMoodChange(callback: MoodChangeCallback): void {
    this.moodCallbacks.push(callback);
  }

  /**
   * 移除心情变化回调
   * @param callback 回调函数
   */
  offMoodChange(callback: MoodChangeCallback): void {
    const index = this.moodCallbacks.indexOf(callback);
    if (index > -1) {
      this.moodCallbacks.splice(index, 1);
    }
  }

  /**
   * 通知心情变化
   */
  private notifyMoodChange(
    oldMood: MoodType,
    newMood: MoodType,
    intensity: number
  ): void {
    for (const callback of this.moodCallbacks) {
      try {
        callback(oldMood, newMood, intensity);
      } catch (error) {
        console.error("Mood callback error:", error);
      }
    }
  }

  /**
   * 启动自动检查
   * @param intervalMs 检查间隔 (毫秒)
   */
  private startAutoCheck(intervalMs: number): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    this.checkTimer = setInterval(() => {
      this.checkMoodTriggers();
    }, intervalMs);
  }

  /**
   * 停止自动检查
   */
  private stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 重置为默认心情
   */
  reset(): void {
    this.setMood("content", 0.5);
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.stopAutoCheck();
    this.moodCallbacks = [];
  }
}
