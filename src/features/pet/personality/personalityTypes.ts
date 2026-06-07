export interface PersonalityDimensions {
  energy: number; // -1 (低能量) to 1 (高能量)
  humor: number; // -1 (严肃) to 1 (幽默)
  curiosity: number; // -1 (保守) to 1 (好奇)
}

export interface DialogueLine {
  id: string;
  text: string;
  scene: string;
  personalityTags: Partial<PersonalityDimensions>;
  priority?: number;
}

export type BondTier = "new" | "warm" | "trusted" | "close";

import type { PetEvent } from '../petState';

export interface BehaviorActionResult {
  behaviorId: string;
  behaviorName: string;
  message: string;
  petEvent?: PetEvent;
}

export interface BehaviorPattern {
  id: string;
  name: string;
  triggerCondition: PersonalityCondition;
  frequency: number; // 每小时触发次数上限
  tags?: BehaviorTag[];
  action: () => BehaviorActionResult | void;
}

export interface BehaviorPriorityState {
  tags: BehaviorTag[];
}

export type BehaviorTag = 'calm' | 'balanced' | 'playful' | 'curious' | 'focused' | 'neutral';

export interface PersonalityCondition {
  energy?: { min: number; max: number };
  humor?: { min: number; max: number };
  curiosity?: { min: number; max: number };
}

export interface InteractionRecord {
  type: 'click' | 'drag' | 'drop' | 'chat' | 'idle' | 'work' | 'celebrate';
  timestamp: number;
  intensity?: number; // 0-1
}

export interface PersonalityChange {
  dimension: keyof PersonalityDimensions;
  delta: number;
  reason: string;
}

export type PersonalityChangeCallback = (changes: PersonalityChange[]) => void;

export interface DialogueScene {
  name: string;
  description: string;
}

export const PERSONALITY_SCENES: Record<string, DialogueScene> = {
  GREETING: { name: 'greeting', description: '见面打招呼' },
  IDLE: { name: 'idle', description: '空闲时' },
  WORKING: { name: 'working', description: '工作中' },
  CELEBRATE: { name: 'celebrate', description: '庆祝成功' },
  ERROR: { name: 'error', description: '出错时' },
  CURIOUS: { name: 'curious', description: '好奇时' },
  SLEEPY: { name: 'sleepy', description: '困倦时' },
  PLAYFUL: { name: 'playful', description: '调皮时' },
};

export const DEFAULT_PERSONALITY: PersonalityDimensions = {
  energy: 0,
  humor: 0,
  curiosity: 0,
};
