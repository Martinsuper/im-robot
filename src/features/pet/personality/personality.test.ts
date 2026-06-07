import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonalityManager } from './PersonalityManager';
import { DialogueSystem } from './DialogueSystem';
import { BehaviorSystem } from './BehaviorSystem';
import { derivePersonalityFromSignals } from './personalityContext';
import { recordPersonalitySignalFromInteraction } from './personalityRuntime';
import type { GrowthSnapshot } from '../interaction';

describe('PersonalityManager', () => {
  let manager: PersonalityManager;

  beforeEach(() => {
    manager = new PersonalityManager();
  });

  it('should initialize with default personality', () => {
    const state = manager.getState();
    expect(state.energy).toBe(0);
    expect(state.humor).toBe(0);
    expect(state.curiosity).toBe(0);
  });

  it('should record interaction', () => {
    manager.recordInteraction({ type: 'chat', timestamp: Date.now() });
  });

  it('should increase energy on click interactions', () => {
    const initialState = manager.getState().energy;
    manager.recordInteraction({ type: 'click', timestamp: Date.now() });
    const newState = manager.getState().energy;
    expect(newState).toBeGreaterThanOrEqual(initialState);
  });

  it('should get tendency', () => {
    const tendency = manager.getTendency();
    expect(tendency).toHaveProperty('isEnergetic');
    expect(tendency).toHaveProperty('isHumorous');
    expect(tendency).toHaveProperty('isCurious');
    expect(tendency).toHaveProperty('energyLevel');
    expect(tendency).toHaveProperty('humorLevel');
    expect(tendency).toHaveProperty('curiosityLevel');
    expect(['low', 'medium', 'high']).toContain(tendency.energyLevel);
    expect(['serious', 'balanced', 'humorous']).toContain(tendency.humorLevel);
    expect(['conservative', 'balanced', 'curious']).toContain(tendency.curiosityLevel);
  });

  it('should trigger callback on personality change', () => {
    const callback = vi.fn();
    manager.onChange(callback);
    manager.recordInteraction({ type: 'celebrate', timestamp: Date.now() });
    expect(callback).toHaveBeenCalled();
  });

  it('should reset personality', () => {
    manager.recordInteraction({ type: 'click', timestamp: Date.now() });
    manager.reset();
    const state = manager.getState();
    expect(state.energy).toBe(0);
    expect(state.humor).toBe(0);
    expect(state.curiosity).toBe(0);
  });
});

describe('DialogueSystem', () => {
  let system: DialogueSystem;

  beforeEach(() => {
    system = new DialogueSystem();
  });

  it('should initialize', () => {
    expect(system).toBeDefined();
  });

  it('should get dialogues by scene', () => {
    const dialogues = system.getDialoguesByScene('greeting');
    expect(Array.isArray(dialogues)).toBe(true);
    expect(dialogues.length).toBeGreaterThan(0);
  });

  it('should get all scenes', () => {
    const scenes = system.getAllScenes();
    expect(Array.isArray(scenes)).toBe(true);
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes).toContain('greeting');
  });
});

describe('BehaviorSystem', () => {
  let manager: PersonalityManager;
  let system: BehaviorSystem;

  beforeEach(() => {
    manager = new PersonalityManager();
    system = new BehaviorSystem(manager);
  });

  it('should initialize', () => {
    expect(system).toBeDefined();
  });

  it('should add custom behavior', () => {
    const customBehavior = {
      id: 'custom_behavior',
      name: 'custom_behavior',
      triggerCondition: { energy: { min: 0.3, max: 1 } },
      frequency: 0.1,
      action: vi.fn(),
    };
    system.addBehavior(customBehavior);
  });

  it('should remove behavior', () => {
    system.addBehavior({
      id: 'test_behavior',
      name: 'test_behavior',
      triggerCondition: {},
      frequency: 0.1,
      action: vi.fn(),
    });
    system.removeBehavior('test_behavior');
  });

  it('should emit trigger events when evaluated', () => {
    const onTrigger = vi.fn();
    system = new BehaviorSystem(manager, onTrigger);
    system.addBehavior({
      id: 'instant_energy',
      name: 'instant_energy',
      triggerCondition: { energy: { min: -1, max: 1 } },
      frequency: 1000,
      action: () => ({
        behaviorId: 'instant_energy',
        behaviorName: 'instant_energy',
        message: 'instant energy triggered',
      }),
    });

    system.start();
    system.evaluateNow();

    expect(onTrigger).toHaveBeenCalled();
    system.stop();
  });

  it('should prefer behaviors that match the configured priority', () => {
    const onTrigger = vi.fn();
    system = new BehaviorSystem(manager, onTrigger);
    system.setBehaviorPriority(['curious', 'playful', 'calm', 'focused', 'balanced', 'neutral']);

    system.addBehavior({
      id: 'priority_playful',
      name: 'priority_playful',
      triggerCondition: {},
      frequency: 1000,
      tags: ['playful'],
      action: () => ({
        behaviorId: 'priority_playful',
        behaviorName: 'priority_playful',
        message: 'playful first',
      }),
    });

    system.addBehavior({
      id: 'priority_curious',
      name: 'priority_curious',
      triggerCondition: {},
      frequency: 1000,
      tags: ['curious'],
      action: () => ({
        behaviorId: 'priority_curious',
        behaviorName: 'priority_curious',
        message: 'curious first',
      }),
    });

    system.start();
    system.evaluateNow();

    expect(onTrigger).toHaveBeenCalled();
    expect(onTrigger.mock.calls[0]?.[0]?.behaviorId).toBe('priority_curious');
    system.stop();
  });
});

describe('personalityContext', () => {
  it('derives personality from interaction signals', () => {
    const personality = derivePersonalityFromSignals(
      {
        totalInteractions: 18,
        clickCount: 8,
        doubleClickCount: 3,
        hoverCount: 4,
        petStrokeCount: 5,
        dragCount: 2,
        dropCount: 1,
        chatCount: 6,
        focusCount: 2,
        intimacy: 14,
      },
      {
        level: 6,
        attributeLevels: { bond: 4, focus: 0, social: 0, vitality: 0, wisdom: 0 } as GrowthSnapshot["attributeLevels"],
      } as Pick<GrowthSnapshot, "level" | "attributeLevels">
    );

    expect(personality.energy).toBeGreaterThan(-1);
    expect(personality.humor).toBeGreaterThan(-1);
    expect(personality.curiosity).toBeGreaterThan(-1);
  });
});

describe('personalityRuntime', () => {
  it('maps interaction events to personality signals', () => {
    expect(recordPersonalitySignalFromInteraction({ type: 'click' })?.type).toBe('click');
    expect(recordPersonalitySignalFromInteraction({ type: 'focus_started' })?.type).toBe('work');
    expect(recordPersonalitySignalFromInteraction({ type: 'chat_completed' })?.type).toBe('celebrate');
  });
});
