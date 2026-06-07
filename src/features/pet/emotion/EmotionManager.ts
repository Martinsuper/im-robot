/**
 * 情感管理器
 * 管理宠物的短期情绪状态
 */

import type {
  PetEmotion,
  EmotionConfig,
  EmotionState,
  EmotionEvent,
  EmotionChangeCallback,
} from "./emotionTypes";
import { EMOTION_CONFIGS } from "./emotionTypes";

/**
 * 情感管理器类
 * 负责管理宠物的情绪状态和变化
 */
export class EmotionManager {
  private currentEmotion: PetEmotion = "neutral";
  private emotionIntensity: number = 1.0;
  private emotionStartTime: number = Date.now();
  private emotionDuration: number = 30000;
  private lastTriggerEvent: EmotionEvent | undefined;
  private emotionCallbacks: EmotionChangeCallback[] = [];
  private decayTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 设置情绪
   * @param emotion 目标情绪
   * @param intensity 情绪强度 (0-1, 默认1.0)
   * @param duration 持续时间 (毫秒, 可选)
   * @param triggerEvent 触发事件 (可选)
   */
  setEmotion(
    emotion: PetEmotion,
    intensity: number = 1.0,
    duration?: number,
    triggerEvent?: EmotionEvent
  ): void {
    const oldEmotion = this.currentEmotion;
    const config = this.getEmotionConfig(emotion);

    // 限制强度范围
    const clampedIntensity = Math.max(0, Math.min(1, intensity));

    // 更新情绪状态
    this.currentEmotion = emotion;
    this.emotionIntensity = clampedIntensity;
    this.emotionStartTime = Date.now();
    this.emotionDuration = duration ?? config.duration;
    this.lastTriggerEvent = triggerEvent;

    // 重置衰减计时器
    this.resetDecayTimer();

    // 通知回调
    if (oldEmotion !== emotion) {
      this.notifyEmotionChange(oldEmotion, emotion, clampedIntensity);
    }
  }

  /**
   * 获取当前情绪
   * @returns 当前情绪类型
   */
  getEmotion(): PetEmotion {
    return this.currentEmotion;
  }

  /**
   * 获取情绪强度
   * @returns 当前情绪强度 (0-1)
   */
  getIntensity(): number {
    return this.emotionIntensity;
  }

  /**
   * 获取完整的的情绪状态
   * @returns 情绪状态对象
   */
  getEmotionState(): EmotionState {
    return {
      currentEmotion: this.currentEmotion,
      intensity: this.emotionIntensity,
      startTime: this.emotionStartTime,
      duration: this.emotionDuration,
      triggerEvent: this.lastTriggerEvent,
    };
  }

  /**
   * 获取情绪配置
   * @param emotion 情绪类型
   * @returns 情绪配置
   */
  getEmotionConfig(emotion: PetEmotion): EmotionConfig {
    return EMOTION_CONFIGS[emotion];
  }

  /**
   * 添加情绪变化回调
   * @param callback 回调函数
   */
  onEmotionChange(callback: EmotionChangeCallback): void {
    this.emotionCallbacks.push(callback);
  }

  /**
   * 移除情绪变化回调
   * @param callback 回调函数
   */
  offEmotionChange(callback: EmotionChangeCallback): void {
    const index = this.emotionCallbacks.indexOf(callback);
    if (index > -1) {
      this.emotionCallbacks.splice(index, 1);
    }
  }

  /**
   * 通知情绪变化
   */
  private notifyEmotionChange(
    oldEmotion: PetEmotion,
    newEmotion: PetEmotion,
    intensity: number
  ): void {
    for (const callback of this.emotionCallbacks) {
      try {
        callback(oldEmotion, newEmotion, intensity);
      } catch (error) {
        console.error("Emotion callback error:", error);
      }
    }
  }

  /**
   * 重置衰减计时器
   */
  private resetDecayTimer(): void {
    // 清除现有计时器
    if (this.decayTimer) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }

    const config = this.getEmotionConfig(this.currentEmotion);
    if (config.decays) {
      // 计算衰减时间 (强度从1.0衰减到0)
      const decayTime = (1 / config.decayRate) * 1000; // 转换为毫秒
      this.decayTimer = setTimeout(() => {
        this.applyDecay();
      }, Math.min(decayTime, this.emotionDuration));
    }
  }

  /**
   * 应用情绪衰减
   */
  private applyDecay(): void {
    const config = this.getEmotionConfig(this.currentEmotion);
    const elapsed = Date.now() - this.emotionStartTime;

    if (elapsed >= this.emotionDuration) {
      // 情绪持续时间结束，返回中性
      this.setEmotion("neutral", 1.0);
      return;
    }

    // 计算衰减后的强度
    const decayAmount = config.decayRate * (elapsed / 1000);
    const newIntensity = Math.max(0, this.emotionIntensity - decayAmount);

    if (newIntensity <= 0) {
      // 强度衰减到0，返回中性
      this.setEmotion("neutral", 1.0);
    } else {
      this.emotionIntensity = newIntensity;
      // 继续衰减
      this.decayTimer = setTimeout(() => {
        this.applyDecay();
      }, 1000); // 每秒检查一次
    }
  }

  /**
   * 重置为中性情绪
   */
  reset(): void {
    this.setEmotion("neutral", 1.0);
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    if (this.decayTimer) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }
    this.emotionCallbacks = [];
  }
}
