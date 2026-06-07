import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmotionManager } from './EmotionManager';
import { MoodManager } from './MoodManager';
import { EmotionTriggers } from './EmotionTriggers';

describe('EmotionManager', () => {
  let manager: EmotionManager;

  beforeEach(() => {
    manager = new EmotionManager();
  });

  it('should initialize with neutral emotion', () => {
    expect(manager.getEmotion()).toBe('neutral');
  });

  it('should set emotion', () => {
    manager.setEmotion('happy');
    expect(manager.getEmotion()).toBe('happy');
  });

  it('should trigger callback on emotion change', () => {
    const callback = vi.fn();
    manager.onEmotionChange(callback);
    manager.setEmotion('excited');
    expect(callback).toHaveBeenCalled();
  });

  it('should not trigger callback when setting same emotion', () => {
    const callback = vi.fn();
    manager.onEmotionChange(callback);
    manager.setEmotion('neutral');
    expect(callback).not.toHaveBeenCalled();
  });

  it('should get emotion state', () => {
    manager.setEmotion('curious');
    const state = manager.getEmotionState();
    expect(state.currentEmotion).toBe('curious');
    expect(state.startTime).toBeGreaterThan(0);
  });

  it('should get emotion intensity', () => {
    manager.setEmotion('happy', 0.8);
    expect(manager.getIntensity()).toBe(0.8);
  });

  it('should reset to neutral', () => {
    manager.setEmotion('excited');
    manager.reset();
    expect(manager.getEmotion()).toBe('neutral');
  });
});

describe('MoodManager', () => {
  let manager: MoodManager;

  beforeEach(() => {
    manager = new MoodManager();
  });

  it('should initialize with content mood', () => {
    expect(manager.getMood()).toBe('content');
  });

  it('should set mood', () => {
    manager.setMood('excited');
    expect(manager.getMood()).toBe('excited');
  });

  it('should get mood state', () => {
    manager.setMood('curious');
    const state = manager.getMoodState();
    expect(state.currentMood).toBe('curious');
    expect(state.startTime).toBeGreaterThan(0);
  });
});

describe('EmotionTriggers', () => {
  let triggers: EmotionTriggers;

  beforeEach(() => {
    triggers = new EmotionTriggers();
  });

  it('should add rule', () => {
    triggers.addRule({ id: 'custom_click', name: 'Custom Click', eventType: 'click', emotion: 'happy', intensity: 0.8, duration: 30000, priority: 10 });
    const rule = triggers.getRule('custom_click');
    expect(rule).toBeDefined();
    expect(rule?.eventType).toBe('click');
    expect(rule?.emotion).toBe('happy');
  });

  it('should get matching rules for event', () => {
    triggers.addRule({ id: 'custom_click', name: 'Custom Click', eventType: 'click', emotion: 'happy', intensity: 0.8, duration: 30000, priority: 10 });
    const rules = triggers.getMatchingRules('click');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].emotion).toBe('happy');
  });
});
