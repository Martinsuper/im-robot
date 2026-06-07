/**
 * 情感系统类型定义
 * 管理宠物的情绪和心情状态
 */

/** 基础情绪类型 - 短期情绪状态 */
export type PetEmotion =
  | "neutral"
  | "happy"
  | "curious"
  | "sleepy"
  | "surprised"
  | "worried"
  | "excited"
  | "thoughtful"
  | "playful";

/** 持久心情类型 - 长期心情状态 */
export type MoodType =
  | "content"      // 满足
  | "excited"      // 兴奋
  | "sleepy"       // 困倦
  | "curious"      // 好奇
  | "proud"        // 自豪
  | "missyou"      // 思念
  | "playful";     // 调皮

/** 情绪配置 - 定义每种情绪的属性 */
export interface EmotionConfig {
  /** 情绪名称 */
  name: PetEmotion;
  /** 情绪显示标签 */
  label: string;
  /** 情绪描述 */
  description: string;
  /** 情绪权重 (影响心情计算) */
  weight: number;
  /** 情绪持续时间 (毫秒) */
  duration: number;
  /** 是否会衰减 */
  decays: boolean;
  /** 衰减速率 (每秒) */
  decayRate: number;
}

/** 心情配置 - 定义每种心情的属性 */
export interface MoodConfig {
  /** 心情名称 */
  name: MoodType;
  /** 心情显示标签 */
  label: string;
  /** 心情描述 */
  description: string;
  /** 触发心情的阈值 */
  threshold: number;
  /** 心情权重 */
  weight: number;
  /** 是否自动触发 */
  autoTrigger: boolean;
  /** 自动触发条件 */
  triggerCondition?: MoodTriggerCondition;
}

/** 心情触发条件 */
export interface MoodTriggerCondition {
  /** 无交互时间阈值 (毫秒) */
  noInteractionMs?: number;
  /** 未登录天数阈值 */
  noLoginDays?: number;
  /** 连续天数阈值 */
  consecutiveDays?: number;
}

/** 情绪事件 - 触发情绪变化的事件 */
export interface EmotionEvent {
  /** 事件类型 */
  type: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件数据 */
  data?: Record<string, unknown>;
  /** 事件来源 */
  source?: string;
}

/** 情绪触发规则 */
export interface EmotionTriggerRule {
  /** 规则ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 触发事件类型 */
  eventType: string;
  /** 目标情绪 */
  emotion: PetEmotion;
  /** 情绪强度 (0-1) */
  intensity: number;
  /** 持续时间 (毫秒, 可选) */
  duration?: number;
  /** 是否覆盖当前情绪 */
  override?: boolean;
  /** 优先级 (越高越优先) */
  priority: number;
  /** 条件函数 (可选) */
  condition?: (event: EmotionEvent) => boolean;
}

/** 情绪状态 */
export interface EmotionState {
  /** 当前情绪 */
  currentEmotion: PetEmotion;
  /** 情绪强度 (0-1) */
  intensity: number;
  /** 情绪开始时间 */
  startTime: number;
  /** 情绪持续时间 */
  duration: number;
  /** 触发事件 */
  triggerEvent?: EmotionEvent;
}

/** 心情状态 */
export interface MoodState {
  /** 当前心情 */
  currentMood: MoodType;
  /** 心情强度 (0-1) */
  intensity: number;
  /** 心情开始时间 */
  startTime: number;
  /** 最后交互时间 */
  lastInteractionTime: number;
  /** 最后登录时间 */
  lastLoginTime: number;
  /** 连续天数 */
  consecutiveDays: number;
}

/** 情绪变化回调 */
export type EmotionChangeCallback = (
  oldEmotion: PetEmotion,
  newEmotion: PetEmotion,
  intensity: number
) => void;

/** 心情变化回调 */
export type MoodChangeCallback = (
  oldMood: MoodType,
  newMood: MoodType,
  intensity: number
) => void;

/** 情绪配置映射 */
export const EMOTION_CONFIGS: Record<PetEmotion, EmotionConfig> = {
  neutral: {
    name: "neutral",
    label: "平静",
    description: "平静、中性的状态",
    weight: 1.0,
    duration: 30000,  // 30秒
    decays: true,
    decayRate: 0.1,
  },
  happy: {
    name: "happy",
    label: "开心",
    description: "快乐、愉悦的情绪",
    weight: 1.2,
    duration: 60000,  // 1分钟
    decays: true,
    decayRate: 0.05,
  },
  curious: {
    name: "curious",
    label: "好奇",
    description: "好奇、探索的状态",
    weight: 1.1,
    duration: 45000,  // 45秒
    decays: true,
    decayRate: 0.08,
  },
  sleepy: {
    name: "sleepy",
    label: "困倦",
    description: "困倦、想睡觉的状态",
    weight: 0.8,
    duration: 120000, // 2分钟
    decays: true,
    decayRate: 0.03,
  },
  surprised: {
    name: "surprised",
    label: "惊讶",
    description: "惊讶、意外的情绪",
    weight: 1.3,
    duration: 30000,  // 30秒
    decays: true,
    decayRate: 0.15,
  },
  worried: {
    name: "worried",
    label: "担心",
    description: "担心、焦虑的情绪",
    weight: 0.9,
    duration: 60000,  // 1分钟
    decays: true,
    decayRate: 0.06,
  },
  excited: {
    name: "excited",
    label: "兴奋",
    description: "兴奋、激动的情绪",
    weight: 1.4,
    duration: 45000,  // 45秒
    decays: true,
    decayRate: 0.12,
  },
  thoughtful: {
    name: "thoughtful",
    label: "思考",
    description: "思考、沉思的状态",
    weight: 1.0,
    duration: 60000,  // 1分钟
    decays: true,
    decayRate: 0.04,
  },
  playful: {
    name: "playful",
    label: "调皮",
    description: "调皮、活泼的情绪",
    weight: 1.3,
    duration: 45000,  // 45秒
    decays: true,
    decayRate: 0.1,
  },
};

/** 心情配置映射 */
export const MOOD_CONFIGS: Record<MoodType, MoodConfig> = {
  content: {
    name: "content",
    label: "满足",
    description: "满足、幸福的心情",
    threshold: 0.6,
    weight: 1.0,
    autoTrigger: false,
  },
  excited: {
    name: "excited",
    label: "兴奋",
    description: "兴奋、期待的心情",
    threshold: 0.7,
    weight: 1.2,
    autoTrigger: false,
  },
  sleepy: {
    name: "sleepy",
    label: "困倦",
    description: "困倦、休息的心情",
    threshold: 0.5,
    weight: 0.8,
    autoTrigger: true,
    triggerCondition: {
      noInteractionMs: 2 * 60 * 60 * 1000, // 2小时
    },
  },
  curious: {
    name: "curious",
    label: "好奇",
    description: "好奇、探索的心情",
    threshold: 0.6,
    weight: 1.1,
    autoTrigger: false,
  },
  proud: {
    name: "proud",
    label: "自豪",
    description: "自豪、成就感的心情",
    threshold: 0.7,
    weight: 1.3,
    autoTrigger: false,
  },
  missyou: {
    name: "missyou",
    label: "思念",
    description: "思念、想念的心情",
    threshold: 0.5,
    weight: 0.9,
    autoTrigger: true,
    triggerCondition: {
      noLoginDays: 3, // 3天未登录
    },
  },
  playful: {
    name: "playful",
    label: "调皮",
    description: "调皮、想玩耍的心情",
    threshold: 0.6,
    weight: 1.2,
    autoTrigger: false,
  },
};
