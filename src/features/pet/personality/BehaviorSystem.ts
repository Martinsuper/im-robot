import type {
  BehaviorActionResult,
  BehaviorPattern,
  BehaviorTag,
  PersonalityDimensions,
} from './personalityTypes';
import { PersonalityManager } from './PersonalityManager';
import type { PetBehaviorPriority, PetBehaviorProfile } from '../interaction/petAi';

export type BehaviorTriggerEvent = BehaviorActionResult;

export type BehaviorTriggerCallback = (event: BehaviorTriggerEvent) => void;

export class BehaviorSystem {
  private behaviors: Map<string, BehaviorPattern> = new Map();
  private activeTimers: Map<string, ReturnType<typeof setTimeout> | number> = new Map();
  private personalityManager: PersonalityManager;
  private onTrigger: BehaviorTriggerCallback | null;
  private behaviorProfile: PetBehaviorProfile = 'balanced';
  private behaviorPriority: PetBehaviorPriority = [];
  private isRunning = false;
  private checkInterval = 300000; // 5分钟检查一次

  constructor(personalityManager: PersonalityManager, onTrigger: BehaviorTriggerCallback | null = null) {
    this.personalityManager = personalityManager;
    this.onTrigger = onTrigger;
    this.registerDefaultBehaviors();
  }

  setOnTrigger(onTrigger: BehaviorTriggerCallback | null): void {
    this.onTrigger = onTrigger;
  }

  setBehaviorProfile(behaviorProfile: PetBehaviorProfile): void {
    this.behaviorProfile = behaviorProfile;
  }

  setBehaviorPriority(behaviorPriority: PetBehaviorPriority): void {
    this.behaviorPriority = behaviorPriority;
  }

  private registerDefaultBehaviors(): void {
    const defaultBehaviors: BehaviorPattern[] = [
      {
        id: 'energetic_fidget',
        name: '精力充沛的小动作',
        triggerCondition: { energy: { min: 0.3, max: 1 } },
        frequency: 6,
        tags: ['playful'],
        action: () => this.triggerFidget('energetic'),
      },
      {
        id: 'playful_animation',
        name: '调皮的动画',
        triggerCondition: { humor: { min: 0.3, max: 1 } },
        frequency: 4,
        tags: ['playful'],
        action: () => this.triggerPlayfulAnimation(),
      },
      {
        id: 'curious_look_around',
        name: '好奇地四处张望',
        triggerCondition: { curiosity: { min: 0.3, max: 1 } },
        frequency: 5,
        tags: ['curious'],
        action: () => this.triggerCuriousLook(),
      },
      {
        id: 'calm_idle',
        name: '平静的休息',
        triggerCondition: { energy: { min: -1, max: -0.3 } },
        frequency: 2,
        tags: ['calm'],
        action: () => this.triggerCalmIdle(),
      },
      {
        id: 'serious_work_mode',
        name: '严肃工作模式',
        triggerCondition: { humor: { min: -1, max: -0.3 } },
        frequency: 3,
        tags: ['focused'],
        action: () => this.triggerSeriousWork(),
      },
      {
        id: 'conservative_stay',
        name: '保守的停留',
        triggerCondition: { curiosity: { min: -1, max: -0.3 } },
        frequency: 2,
        tags: ['calm'],
        action: () => this.triggerConservativeStay(),
      },
    ];

    for (const behavior of defaultBehaviors) {
      this.behaviors.set(behavior.id, behavior);
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.evaluateNow();
    this.scheduleBehaviorChecks();
  }

  stop(): void {
    this.isRunning = false;
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  private scheduleBehaviorChecks(): void {
    if (!this.isRunning) return;

    const timer = globalThis.setTimeout(() => {
      this.checkAndTriggerBehaviors();
      this.scheduleBehaviorChecks();
    }, this.checkInterval);

    this.activeTimers.set('main', timer);
  }

  evaluateNow(): void {
    if (!this.isRunning) return;
    this.checkAndTriggerBehaviors();
  }

  private checkAndTriggerBehaviors(): void {
    const personality = this.personalityManager.getState();

    const eligibleBehaviors = Array.from(this.behaviors.values()).filter((behavior) =>
      this.shouldTrigger(behavior, personality)
    );

    eligibleBehaviors.sort((left, right) => this.scoreBehavior(right) - this.scoreBehavior(left));

    for (const behavior of eligibleBehaviors) {
      if (this.executeBehaviorWithFrequency(behavior)) {
        break;
      }
    }
  }

  private shouldTrigger(behavior: BehaviorPattern, personality: PersonalityDimensions): boolean {
    const condition = behavior.triggerCondition;

    if (condition.energy) {
      if (
        personality.energy < condition.energy.min ||
        personality.energy > condition.energy.max
      ) {
        return false;
      }
    }

    if (condition.humor) {
      if (
        personality.humor < condition.humor.min ||
        personality.humor > condition.humor.max
      ) {
        return false;
      }
    }

    if (condition.curiosity) {
      if (
        personality.curiosity < condition.curiosity.min ||
        personality.curiosity > condition.curiosity.max
      ) {
        return false;
      }
    }

    return true;
  }

  private executeBehaviorWithFrequency(behavior: BehaviorPattern): boolean {
    const lastExecutionKey = `last_${behavior.id}`;
    const lastExecution = (this.activeTimers.get(lastExecutionKey) as number | undefined) || 0;
    const now = Date.now();
    const minInterval = ((60 * 60 * 1000) / behavior.frequency) * this.getBehaviorFrequencyMultiplier(behavior); // 毫秒

    if (now - lastExecution < minInterval) {
      return false;
    }

    const result = behavior.action();
    if (result) this.onTrigger?.(result);
    this.activeTimers.set(lastExecutionKey, now);
    return true;
  }

  private getBehaviorFrequencyMultiplier(behavior: BehaviorPattern): number {
    const tags = behavior.tags ?? ['neutral'];
    const profileBias: Record<PetBehaviorProfile, Partial<Record<BehaviorTag, number>>> = {
      calm: { calm: 0.7, focused: 0.95, curious: 1.05, playful: 1.3, neutral: 1 },
      balanced: { calm: 1, focused: 1, curious: 1, playful: 1, neutral: 1 },
      playful: { calm: 1.25, focused: 1.1, curious: 0.95, playful: 0.7, neutral: 1 },
      curious: { calm: 1.1, focused: 1.05, curious: 0.7, playful: 0.95, neutral: 1 },
      focused: { calm: 0.9, focused: 0.65, curious: 1.2, playful: 1.25, neutral: 1 },
    };

    const bias = profileBias[this.behaviorProfile];
    const multipliers = tags.map((tag) => bias[tag] ?? 1);
    const average = multipliers.reduce((sum, value) => sum + value, 0) / multipliers.length;
    return Math.max(0.55, Math.min(1.6, average));
  }

  private scoreBehavior(behavior: BehaviorPattern): number {
    const tags = behavior.tags ?? ['neutral'];
    const priorityIndex = new Map<BehaviorTag, number>();
    this.behaviorPriority.forEach((tag, index) => priorityIndex.set(tag, index));

    const priorityBonus = tags.reduce((sum, tag) => {
      const index = priorityIndex.get(tag);
      if (index === undefined) return sum + 1;
      return sum + Math.max(1, 8 - index * 2);
    }, 0);

    const profileMultiplier = this.getBehaviorFrequencyMultiplier(behavior);
    return priorityBonus * profileMultiplier;
  }

  private triggerFidget(type: string): BehaviorTriggerEvent {
    console.debug(`[BehaviorSystem] Triggering fidget: ${type}`);
    return {
      behaviorId: 'energetic_fidget',
      behaviorName: '精力充沛的小动作',
      message: type === 'energetic' ? 'Piko 轻轻晃了晃。' : 'Piko 活动了一下。',
      petEvent: { type: 'FIDGET', intensity: type === 'energetic' ? 'normal' : 'soft' },
    };
  }

  private triggerPlayfulAnimation(): BehaviorTriggerEvent {
    console.debug('[BehaviorSystem] Triggering playful animation');
    return {
      behaviorId: 'playful_animation',
      behaviorName: '调皮的动画',
      message: 'Piko 像是在偷偷开心。',
      petEvent: { type: 'PET_STROKED' },
    };
  }

  private triggerCuriousLook(): BehaviorTriggerEvent {
    console.debug('[BehaviorSystem] Triggering curious look around');
    return {
      behaviorId: 'curious_look_around',
      behaviorName: '好奇地四处张望',
      message: 'Piko 朝四周看了看。',
      petEvent: { type: 'HOVER' },
    };
  }

  private triggerCalmIdle(): BehaviorTriggerEvent {
    console.debug('[BehaviorSystem] Triggering calm idle');
    return {
      behaviorId: 'calm_idle',
      behaviorName: '平静的休息',
      message: 'Piko 安静下来。',
      petEvent: { type: 'REST' },
    };
  }

  private triggerSeriousWork(): BehaviorTriggerEvent {
    console.debug('[BehaviorSystem] Triggering serious work mode');
    return {
      behaviorId: 'serious_work_mode',
      behaviorName: '严肃工作模式',
      message: 'Piko 调整到更专注的状态。',
      petEvent: { type: 'WORK_STARTED' },
    };
  }

  private triggerConservativeStay(): BehaviorTriggerEvent {
    console.debug('[BehaviorSystem] Triggering conservative stay');
    return {
      behaviorId: 'conservative_stay',
      behaviorName: '保守的停留',
      message: 'Piko 没有急着靠近。',
      petEvent: { type: 'RESET' },
    };
  }

  addBehavior(behavior: BehaviorPattern): void {
    this.behaviors.set(behavior.id, behavior);
  }

  removeBehavior(id: string): boolean {
    return this.behaviors.delete(id);
  }

  getActiveBehaviors(): BehaviorPattern[] {
    return Array.from(this.behaviors.values());
  }
}
