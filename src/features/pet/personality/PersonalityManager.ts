import type {
  PersonalityDimensions,
  PersonalityChangeCallback,
  InteractionRecord,
  PersonalityChange,
} from './personalityTypes';
import { DEFAULT_PERSONALITY } from './personalityTypes';

export class PersonalityManager {
  private dimensions: PersonalityDimensions = { ...DEFAULT_PERSONALITY };
  private callbacks: PersonalityChangeCallback[] = [];
  private interactionHistory: InteractionRecord[] = [];
  private readonly maxHistorySize = 100;

  constructor(initialDimensions?: Partial<PersonalityDimensions>) {
    if (initialDimensions) {
      this.dimensions = { ...DEFAULT_PERSONALITY, ...initialDimensions };
    }
  }

  getState(): Readonly<PersonalityDimensions> {
    return { ...this.dimensions };
  }

  setState(nextState: Partial<PersonalityDimensions>): void {
    this.dimensions = {
      ...DEFAULT_PERSONALITY,
      ...this.dimensions,
      ...nextState,
    };
  }

  getTendency(): {
    isEnergetic: boolean;
    isHumorous: boolean;
    isCurious: boolean;
    energyLevel: 'low' | 'medium' | 'high';
    humorLevel: 'serious' | 'balanced' | 'humorous';
    curiosityLevel: 'conservative' | 'balanced' | 'curious';
  } {
    const { energy, humor, curiosity } = this.dimensions;

    return {
      isEnergetic: energy > 0.3,
      isHumorous: humor > 0.3,
      isCurious: curiosity > 0.3,
      energyLevel: energy > 0.3 ? 'high' : energy < -0.3 ? 'low' : 'medium',
      humorLevel: humor > 0.3 ? 'humorous' : humor < -0.3 ? 'serious' : 'balanced',
      curiosityLevel: curiosity > 0.3 ? 'curious' : curiosity < -0.3 ? 'conservative' : 'balanced',
    };
  }

  recordInteraction(interaction: InteractionRecord): void {
    this.interactionHistory.push(interaction);
    if (this.interactionHistory.length > this.maxHistorySize) {
      this.interactionHistory.shift();
    }

    const changes = this.calculateChanges(interaction);
    if (changes.length > 0) {
      this.applyChanges(changes);
      this.notifyCallbacks(changes);
    }
  }

  onChange(callback: PersonalityChangeCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  private calculateChanges(interaction: InteractionRecord): PersonalityChange[] {
    const changes: PersonalityChange[] = [];
    const now = Date.now();
    const recentInteractions = this.interactionHistory.filter(
      (record) => now - record.timestamp < 3600000 // 最近1小时
    );

    const clickCount = recentInteractions.filter((r) => r.type === 'click').length;
    const chatCount = recentInteractions.filter((r) => r.type === 'chat').length;
    const idleTime = recentInteractions
      .filter((r) => r.type === 'idle')
      .reduce((sum, r) => sum + (r.intensity || 1), 0);

    // 点击交互增加活力
    if (interaction.type === 'click' && clickCount < 10) {
      changes.push({ dimension: 'energy', delta: 0.05, reason: 'click_interaction' });
    }

    // 对话交互增加好奇心
    if (interaction.type === 'chat' && chatCount < 15) {
      changes.push({ dimension: 'curiosity', delta: 0.08, reason: 'chat_interaction' });
    }

    // 庆祝活动增加幽默感
    if (interaction.type === 'celebrate') {
      changes.push({ dimension: 'humor', delta: 0.1, reason: 'celebrate_interaction' });
    }

    // 拖拽与投喂增加活力与好奇心
    if (interaction.type === 'drag') {
      changes.push({ dimension: 'energy', delta: 0.04, reason: 'drag_interaction' });
    }
    if (interaction.type === 'drop') {
      changes.push({ dimension: 'curiosity', delta: 0.05, reason: 'drop_interaction' });
    }

    // 长时间空闲降低能量
    if (interaction.type === 'idle' && idleTime > 5) {
      changes.push({ dimension: 'energy', delta: -0.03, reason: 'extended_idle' });
    }

    // 工作减少幽默感
    if (interaction.type === 'work' && recentInteractions.filter((r) => r.type === 'work').length > 5) {
      changes.push({ dimension: 'humor', delta: -0.05, reason: 'heavy_workload' });
    }

    return changes;
  }

  private applyChanges(changes: PersonalityChange[]): void {
    for (const change of changes) {
      const currentValue = this.dimensions[change.dimension];
      const newValue = Math.max(-1, Math.min(1, currentValue + change.delta));
      this.dimensions[change.dimension] = newValue;
    }
  }

  private notifyCallbacks(changes: PersonalityChange[]): void {
    for (const callback of this.callbacks) {
      callback(changes);
    }
  }

  reset(): void {
    this.dimensions = { ...DEFAULT_PERSONALITY };
    this.interactionHistory = [];
    this.notifyCallbacks([
      { dimension: 'energy', delta: 0, reason: 'reset' },
      { dimension: 'humor', delta: 0, reason: 'reset' },
      { dimension: 'curiosity', delta: 0, reason: 'reset' },
    ]);
  }
}
