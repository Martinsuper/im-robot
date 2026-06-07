/**
 * 情感系统模块导出
 * 统一导出所有情感系统相关的类、类型和工具函数
 */

// 类型定义
export type {
  PetEmotion,
  MoodType,
  EmotionConfig,
  MoodConfig,
  MoodTriggerCondition,
  EmotionEvent,
  EmotionTriggerRule,
  EmotionState,
  MoodState,
  EmotionChangeCallback,
  MoodChangeCallback,
} from "./emotionTypes";

// 配置常量
export { EMOTION_CONFIGS, MOOD_CONFIGS } from "./emotionTypes";

// 管理器类
export { EmotionManager } from "./EmotionManager";
export { MoodManager } from "./MoodManager";

// 触发器和工具函数
export {
  EmotionTriggers,
  createEmotionEvent,
  createClickEvent,
  createDoubleClickEvent,
  createHoverEvent,
  createChatStartEvent,
  createChatCompleteEvent,
  createChatErrorEvent,
  createFileDropEvent,
  createFileProcessEvent,
  createFileCompleteEvent,
  createPetEvent,
  createSurpriseEvent,
  DEFAULT_TRIGGER_RULES,
} from "./EmotionTriggers";
