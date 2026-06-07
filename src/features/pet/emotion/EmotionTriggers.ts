/**
 * 情绪触发规则
 * 定义各种事件的情绪触发规则
 */

import type {
  PetEmotion,
  EmotionEvent,
  EmotionTriggerRule,
} from "./emotionTypes";

/**
 * 默认的情绪触发规则
 */
export const DEFAULT_TRIGGER_RULES: EmotionTriggerRule[] = [
  // 鼠标交互
  {
    id: "click",
    name: "点击",
    eventType: "click",
    emotion: "happy",
    intensity: 0.8,
    duration: 30000,
    priority: 10,
  },
  {
    id: "double_click",
    name: "双击",
    eventType: "double_click",
    emotion: "playful",
    intensity: 0.9,
    duration: 45000,
    priority: 15,
  },
  {
    id: "hover",
    name: "悬停",
    eventType: "hover",
    emotion: "curious",
    intensity: 0.5,
    duration: 15000,
    priority: 5,
  },

  // 聊天交互
  {
    id: "chat_start",
    name: "开始聊天",
    eventType: "chat_start",
    emotion: "curious",
    intensity: 0.7,
    duration: 30000,
    priority: 20,
  },
  {
    id: "chat_complete",
    name: "聊天完成",
    eventType: "chat_complete",
    emotion: "happy",
    intensity: 0.8,
    duration: 45000,
    priority: 25,
  },
  {
    id: "chat_error",
    name: "聊天错误",
    eventType: "chat_error",
    emotion: "worried",
    intensity: 0.6,
    duration: 60000,
    priority: 30,
  },

  // 文件操作
  {
    id: "file_drop",
    name: "文件拖放",
    eventType: "file_drop",
    emotion: "excited",
    intensity: 0.8,
    duration: 30000,
    priority: 20,
  },
  {
    id: "file_process",
    name: "文件处理",
    eventType: "file_process",
    emotion: "thoughtful",
    intensity: 0.7,
    duration: 60000,
    priority: 25,
  },
  {
    id: "file_complete",
    name: "文件处理完成",
    eventType: "file_complete",
    emotion: "excited",
    intensity: 0.9,
    duration: 45000,
    priority: 30,
  },

  // 系统事件
  {
    id: "wake",
    name: "唤醒",
    eventType: "wake",
    emotion: "happy",
    intensity: 0.8,
    duration: 60000,
    priority: 40,
  },
  {
    id: "rest",
    name: "休息",
    eventType: "rest",
    emotion: "sleepy",
    intensity: 0.7,
    duration: 120000,
    priority: 35,
  },
  {
    id: "error",
    name: "错误",
    eventType: "error",
    emotion: "worried",
    intensity: 0.6,
    duration: 60000,
    priority: 50,
  },

  // 特殊交互
  {
    id: "pet",
    name: "抚摸",
    eventType: "pet",
    emotion: "happy",
    intensity: 1.0,
    duration: 60000,
    priority: 45,
  },
  {
    id: "surprise",
    name: "惊喜",
    eventType: "surprise",
    emotion: "surprised",
    intensity: 0.9,
    duration: 30000,
    priority: 35,
  },
];

/**
 * 情绪触发器类
 * 管理和执行情绪触发规则
 */
export class EmotionTriggers {
  private rules: Map<string, EmotionTriggerRule> = new Map();

  /**
   * 构造函数
   * @param initialRules 初始规则列表 (可选, 使用默认规则)
   */
  constructor(initialRules?: EmotionTriggerRule[]) {
    const rules = initialRules ?? DEFAULT_TRIGGER_RULES;
    for (const rule of rules) {
      this.rules.set(rule.id, rule);
    }
  }

  /**
   * 添加触发规则
   * @param rule 触发规则
   */
  addRule(rule: EmotionTriggerRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * 移除触发规则
   * @param ruleId 规则ID
   */
  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  /**
   * 获取触发规则
   * @param ruleId 规则ID
   * @returns 触发规则或undefined
   */
  getRule(ruleId: string): EmotionTriggerRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * 获取所有规则
   * @returns 规则数组
   */
  getAllRules(): EmotionTriggerRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * 根据事件类型获取匹配的规则
   * @param eventType 事件类型
   * @returns 匹配的规则数组（按优先级降序排列）
   */
  getMatchingRules(eventType: string): EmotionTriggerRule[] {
    return Array.from(this.rules.values())
      .filter((rule) => rule.eventType === eventType)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 处理事件，获取应该触发的情绪
   * @param event 事件对象
   * @returns 匹配的情绪信息或null
   */
  processEvent(event: EmotionEvent): {
    emotion: PetEmotion;
    intensity: number;
    duration?: number;
    override: boolean;
  } | null {
    const matchingRules = this.getMatchingRules(event.type);

    for (const rule of matchingRules) {
      // 检查条件函数
      if (rule.condition && !rule.condition(event)) {
        continue;
      }

      return {
        emotion: rule.emotion,
        intensity: rule.intensity,
        duration: rule.duration,
        override: rule.override ?? false,
      };
    }

    return null;
  }

  /**
   * 检查是否有匹配的规则
   * @param eventType 事件类型
   * @returns 是否有匹配的规则
   */
  hasMatchingRule(eventType: string): boolean {
    return this.getMatchingRules(eventType).length > 0;
  }

  /**
   * 清空所有规则
   */
  clearRules(): void {
    this.rules.clear();
  }

  /**
   * 重置为默认规则
   */
  resetToDefaults(): void {
    this.clearRules();
    for (const rule of DEFAULT_TRIGGER_RULES) {
      this.rules.set(rule.id, rule);
    }
  }
}

/**
 * 创建自定义事件
 * @param type 事件类型
 * @param data 事件数据 (可选)
 * @param source 事件来源 (可选)
 * @returns 事件对象
 */
export function createEmotionEvent(
  type: string,
  data?: Record<string, unknown>,
  source?: string
): EmotionEvent {
  return {
    type,
    timestamp: Date.now(),
    data,
    source,
  };
}

/**
 * 鼠标点击事件
 */
export function createClickEvent(x: number, y: number): EmotionEvent {
  return createEmotionEvent("click", { x, y }, "mouse");
}

/**
 * 鼠标双击事件
 */
export function createDoubleClickEvent(x: number, y: number): EmotionEvent {
  return createEmotionEvent("double_click", { x, y }, "mouse");
}

/**
 * 鼠标悬停事件
 */
export function createHoverEvent(x: number, y: number): EmotionEvent {
  return createEmotionEvent("hover", { x, y }, "mouse");
}

/**
 * 聊天开始事件
 */
export function createChatStartEvent(message: string): EmotionEvent {
  return createEmotionEvent("chat_start", { message }, "chat");
}

/**
 * 聊天完成事件
 */
export function createChatCompleteEvent(response: string): EmotionEvent {
  return createEmotionEvent("chat_complete", { response }, "chat");
}

/**
 * 聊天错误事件
 */
export function createChatErrorEvent(error: string): EmotionEvent {
  return createEmotionEvent("chat_error", { error }, "chat");
}

/**
 * 文件拖放事件
 */
export function createFileDropEvent(fileName: string, fileSize: number): EmotionEvent {
  return createEmotionEvent("file_drop", { fileName, fileSize }, "file");
}

/**
 * 文件处理事件
 */
export function createFileProcessEvent(fileName: string): EmotionEvent {
  return createEmotionEvent("file_process", { fileName }, "file");
}

/**
 * 文件处理完成事件
 */
export function createFileCompleteEvent(fileName: string): EmotionEvent {
  return createEmotionEvent("file_complete", { fileName }, "file");
}

/**
 * 抚摸事件
 */
export function createPetEvent(): EmotionEvent {
  return createEmotionEvent("pet", undefined, "interaction");
}

/**
 * 惊喜事件
 */
export function createSurpriseEvent(message: string): EmotionEvent {
  return createEmotionEvent("surprise", { message }, "interaction");
}
