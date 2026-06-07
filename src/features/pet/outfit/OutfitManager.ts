import type {
  OutfitState,
  OutfitItem,
  OutfitCategory,
  OutfitChangeCallback,
  OutfitCatalog,
} from "./outfitTypes";
import { defaultOutfitState, defaultOutfitCatalog } from "./outfitTypes";

/**
 * 装扮管理器
 * 管理精灵装扮的设置、解锁状态和变化回调
 */
export class OutfitManager {
  private state: OutfitState = { ...defaultOutfitState };
  private catalog: OutfitCatalog = { ...defaultOutfitCatalog };
  private callbacks: OutfitChangeCallback[] = [];

  /**
   * 设置装扮
   * @param category 装扮类别
   * @param itemId 装扮物品ID，null表示移除该类别装扮
   */
  setOutfit(category: OutfitCategory, itemId: string | null): void {
    if (itemId !== null) {
      const item = this.getItemById(itemId);
      if (!item || item.unlockState === "locked") {
        return;
      }
    }

    this.state[category] = itemId;
    this.notifyCallbacks();
  }

  /**
   * 获取当前装扮状态
   */
  getOutfit(): OutfitState {
    return { ...this.state };
  }

  /**
   * 获取指定类别的装扮物品
   * @param category 装扮类别
   */
  getOutfitItem(category: OutfitCategory): OutfitItem | null {
    const itemId = this.state[category];
    if (!itemId) return null;
    return this.getItemById(itemId);
  }

  /**
   * 解锁装扮物品
   * @param itemId 装扮物品ID
   */
  unlockOutfit(itemId: string): boolean {
    const item = this.getItemById(itemId);
    if (!item) return false;

    item.unlockState = "unlocked";
    return true;
  }

  /**
   * 检查装扮物品是否已解锁
   * @param itemId 装扮物品ID
   */
  isOutfitUnlocked(itemId: string): boolean {
    const item = this.getItemById(itemId);
    return item ? item.unlockState === "unlocked" : false;
  }

  /**
   * 获取所有已解锁的装扮物品
   */
  getUnlockedOutfits(): OutfitItem[] {
    const allItems = [
      ...this.catalog.hats,
      ...this.catalog.accessories,
      ...this.catalog.backgrounds,
      ...this.catalog.effects,
    ];
    return allItems.filter((item) => item.unlockState === "unlocked");
  }

  /**
   * 获取指定类别的所有装扮物品
   * @param category 装扮类别
   */
  getOutfitsByCategory(category: OutfitCategory): OutfitItem[] {
    switch (category) {
      case "hat":
        return [...this.catalog.hats];
      case "accessory":
        return [...this.catalog.accessories];
      case "background":
        return [...this.catalog.backgrounds];
      case "effect":
        return [...this.catalog.effects];
      default:
        return [];
    }
  }

  /**
   * 加载装扮目录
   * @param catalog 装扮目录配置
   */
  loadCatalog(catalog: OutfitCatalog): void {
    this.catalog = { ...catalog };
  }

  /**
   * 注册装扮变化回调
   * @param callback 回调函数
   */
  onChange(callback: OutfitChangeCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * 重置装扮到默认状态
   */
  reset(): void {
    this.state = { ...defaultOutfitState };
    this.notifyCallbacks();
  }

  /**
   * 根据ID查找装扮物品
   * @param itemId 装扮物品ID
   */
  private getItemById(itemId: string): OutfitItem | null {
    const allItems = [
      ...this.catalog.hats,
      ...this.catalog.accessories,
      ...this.catalog.backgrounds,
      ...this.catalog.effects,
    ];
    return allItems.find((item) => item.id === itemId) || null;
  }

  /**
   * 通知所有回调装扮已变化
   */
  private notifyCallbacks(): void {
    const state = this.getOutfit();
    this.callbacks.forEach((callback) => callback(state));
  }
}

// 导出单例实例
export const outfitManager = new OutfitManager();
