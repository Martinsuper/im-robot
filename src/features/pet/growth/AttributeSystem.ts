// 属性系统
import type { Attribute, AttributeType, PetGrowth, ExperienceInfo } from "./growthTypes";

// 属性配置
const MAX_ATTRIBUTE_LEVEL = 20;
const BASE_ATTRIBUTE_XP = 50;
const ATTRIBUTE_XP_MULTIPLIER = 1.2;

// 属性中文名称映射
export const ATTRIBUTE_NAMES: Record<AttributeType, string> = {
  wisdom: "智慧",
  focus: "专注",
  social: "社交",
  vitality: "活力",
  bond: "羁绊",
};

export class AttributeSystem {
  /**
   * 初始化属性系统
   */
  static initializeAttributes(): Record<AttributeType, Attribute> {
    const attributes: Record<AttributeType, Attribute> = {} as Record<AttributeType, Attribute>;

    const types: AttributeType[] = ["wisdom", "focus", "social", "vitality", "bond"];
    for (const type of types) {
      attributes[type] = {
        type,
        level: 1,
        currentXp: 0,
        requiredXp: this.getRequiredXp(1),
      };
    }

    return attributes;
  }

  /**
   * 计算指定属性等级所需的升级经验
   */
  static getRequiredXp(level: number): number {
    return Math.floor(BASE_ATTRIBUTE_XP * Math.pow(level, ATTRIBUTE_XP_MULTIPLIER));
  }

  /**
   * 获取属性经验信息
   */
  static getAttributeExperienceInfo(attribute: Attribute): ExperienceInfo {
    const percentage = Math.min((attribute.currentXp / attribute.requiredXp) * 100, 100);
    return {
      level: attribute.level,
      currentXp: attribute.currentXp,
      requiredXp: attribute.requiredXp,
      percentage,
    };
  }

  /**
   * 为指定属性添加经验值
   */
  static addXp(
    growth: PetGrowth,
    attributeType: AttributeType,
    xp: number
  ): PetGrowth {
    const attribute = { ...growth.attributes[attributeType] };

    // 已满级不再增加
    if (attribute.level >= MAX_ATTRIBUTE_LEVEL) {
      return growth;
    }

    attribute.currentXp += xp;

    // 检测升级
    while (attribute.level < MAX_ATTRIBUTE_LEVEL) {
      if (attribute.currentXp >= attribute.requiredXp) {
        attribute.currentXp -= attribute.requiredXp;
        attribute.level++;
        attribute.requiredXp = this.getRequiredXp(attribute.level);
      } else {
        break;
      }
    }

    // 确保经验不超过上限
    if (attribute.level >= MAX_ATTRIBUTE_LEVEL) {
      attribute.currentXp = 0;
    }

    const updatedAttributes = {
      ...growth.attributes,
      [attributeType]: attribute,
    };

    return {
      ...growth,
      attributes: updatedAttributes,
    };
  }

  /**
   * 获取属性等级
   */
  static getLevel(growth: PetGrowth, attributeType: AttributeType): number {
    return growth.attributes[attributeType].level;
  }

  /**
   * 获取所有属性信息
   */
  static getAllAttributes(growth: PetGrowth): Attribute[] {
    return Object.values(growth.attributes);
  }

  /**
   * 根据成长等级自动分配属性点
   */
  static autoAssignAttributes(
    growth: PetGrowth,
    points: number
  ): PetGrowth {
    let updatedGrowth = { ...growth };
    const types: AttributeType[] = ["wisdom", "focus", "social", "vitality", "bond"];

    // 简单平均分配
    const pointsPerAttribute = Math.floor(points / types.length);
    const remainder = points % types.length;

    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const additionalXp = pointsPerAttribute + (i < remainder ? 1 : 0);
      updatedGrowth = this.addXp(updatedGrowth, type, additionalXp * 10); // 每点转换为10经验
    }

    return updatedGrowth;
  }
}