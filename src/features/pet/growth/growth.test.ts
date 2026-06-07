import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GrowthManager } from './GrowthManager';
import { ExperienceSystem } from './ExperienceSystem';
import { AttributeSystem } from './AttributeSystem';

describe('ExperienceSystem', () => {
  it('should calculate required experience for level 1', () => {
    const required = ExperienceSystem.getRequiredXp(1);
    expect(required).toBe(Math.floor(100 * 1 * 1.15));
  });

  it('should calculate required experience for level 10', () => {
    const required = ExperienceSystem.getRequiredXp(10);
    expect(required).toBe(1150); // 100 * 10 * 1.15 = 1150, floor is 1150
  });

  it('should add experience', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: {} as any, achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const result = ExperienceSystem.addExperience(growth, 50);
    expect(result.growth.currentXp).toBe(50);
    expect(result.levelUps.length).toBe(0);
  });

  it('should level up when enough experience', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: {} as any, achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const result = ExperienceSystem.addExperience(growth, ExperienceSystem.getRequiredXp(1));
    expect(result.levelUps.length).toBe(1);
    expect(result.levelUps[0].newLevel).toBe(2);
  });

  it('should handle multiple level ups', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: {} as any, achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const xpNeeded = ExperienceSystem.getRequiredXp(1) + ExperienceSystem.getRequiredXp(2);
    const result = ExperienceSystem.addExperience(growth, xpNeeded);
    expect(result.levelUps.length).toBeGreaterThanOrEqual(2);
  });

  it('should get experience info', () => {
    const growth = { level: 1, currentXp: 50, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: {} as any, achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const info = ExperienceSystem.getExperienceInfo(growth);
    expect(info.level).toBe(1);
    expect(info.currentXp).toBe(50);
    expect(info.requiredXp).toBe(ExperienceSystem.getRequiredXp(1));
  });
});

describe('AttributeSystem', () => {
  it('should initialize attributes', () => {
    const attrs = AttributeSystem.initializeAttributes();
    expect(attrs.wisdom.level).toBe(1);
    expect(attrs.focus.level).toBe(1);
    expect(attrs.social.level).toBe(1);
    expect(attrs.vitality.level).toBe(1);
    expect(attrs.bond.level).toBe(1);
  });

  it('should add xp to attribute', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: AttributeSystem.initializeAttributes(), achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const result = AttributeSystem.addXp(growth, 'wisdom', 30);
    expect(result.attributes.wisdom.currentXp).toBe(30);
  });

  it('should level up attribute when enough xp', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: AttributeSystem.initializeAttributes(), achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const result = AttributeSystem.addXp(growth, 'wisdom', 60);
    expect(result.attributes.wisdom.level).toBe(2);
  });

  it('should get attribute level', () => {
    const growth = { level: 1, currentXp: 0, requiredXp: ExperienceSystem.getRequiredXp(1), attributes: AttributeSystem.initializeAttributes(), achievements: [], dailyTasks: [], lastDailyReset: Date.now() };
    const level = AttributeSystem.getLevel(growth, 'wisdom');
    expect(level).toBe(1);
  });
});

describe('GrowthManager', () => {
  let manager: GrowthManager;

  beforeEach(() => {
    manager = new GrowthManager();
  });

  it('should initialize with level 1', () => {
    expect(manager.getLevel()).toBe(1);
  });

  it('should add experience', () => {
    manager.addExperience(5);
    const info = manager.getExperienceInfo();
    expect(info.currentXp).toBe(5);
  });

  it('should level up after enough experience', () => {
    for (let i = 0; i < 25; i++) {
      manager.addExperience(5);
    }
    expect(manager.getLevel()).toBeGreaterThan(1);
  });

  it('should update attributes when adding experience', () => {
    manager.addAttributeXp('social', 100);
    const attrs = manager.getAttributes();
    expect(attrs.social.currentXp).toBeGreaterThan(0);
  });

  it('should get growth state', () => {
    const state = manager.getGrowthState();
    expect(state).toHaveProperty('level');
    expect(state).toHaveProperty('currentXp');
  });

  it('should trigger level up callback', () => {
    const callback = vi.fn();
    manager.setOnLevelUp(callback);
    for (let i = 0; i < 25; i++) {
      manager.addExperience(5);
    }
    expect(callback).toHaveBeenCalled();
  });

  it('should get stats', () => {
    const stats = manager.getStats();
    expect(stats).toHaveProperty('level');
    expect(stats).toHaveProperty('totalXp');
    expect(stats).toHaveProperty('attributeLevels');
  });
});
