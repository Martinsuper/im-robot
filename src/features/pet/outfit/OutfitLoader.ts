import type { OutfitItem, OutfitCategory } from "./outfitTypes";

// 素材缓存接口
interface AssetCache {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

/**
 * 素材加载器
 * 负责加载、缓存和管理装扮素材
 */
export class OutfitLoader {
  private cache: Map<string, AssetCache> = new Map();
  private preloadQueue: Set<string> = new Set();

  /**
   * 加载装扮素材
   * @param item 装扮物品
   * @returns 加载完成的图片元素
   */
  async loadAsset(item: OutfitItem): Promise<HTMLImageElement> {
    const cacheKey = item.id;

    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.loaded) return cached.image;
      if (cached.error)
        throw new Error(`Failed to load asset: ${item.assetPath}`);
    }

    // 创建新的加载请求
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const cacheEntry: AssetCache = {
        image: img,
        loaded: false,
        error: false,
      };

      this.cache.set(cacheKey, cacheEntry);

      img.onload = () => {
        cacheEntry.loaded = true;
        resolve(img);
      };

      img.onerror = () => {
        cacheEntry.error = true;
        reject(new Error(`Failed to load asset: ${item.assetPath}`));
      };

      img.src = item.assetPath;
    });
  }

  /**
   * 预加载装扮素材
   * @param items 装扮物品列表
   */
  async preloadAssets(items: OutfitItem[]): Promise<void> {
    const loadPromises = items.map((item) =>
      this.loadAsset(item).catch(() => {}),
    );
    await Promise.all(loadPromises);
  }

  /**
   * 预加载指定类别的所有装扮
   * @param category 装扮类别
   * @param items 该类别的装扮物品列表
   */
  async preloadCategory(
    category: OutfitCategory,
    items: OutfitItem[],
  ): Promise<void> {
    this.preloadQueue.add(category);
    await this.preloadAssets(items);
    this.preloadQueue.delete(category);
  }

  /**
   * 检查素材是否已加载
   * @param itemId 装扮物品ID
   */
  isAssetLoaded(itemId: string): boolean {
    const cached = this.cache.get(itemId);
    return cached ? cached.loaded : false;
  }

  /**
   * 获取已加载的图片元素
   * @param itemId 装扮物品ID
   */
  getLoadedAsset(itemId: string): HTMLImageElement | null {
    const cached = this.cache.get(itemId);
    return cached && cached.loaded ? cached.image : null;
  }

  /**
   * 清除指定装扮物品的缓存
   * @param itemId 装扮物品ID
   */
  clearAsset(itemId: string): void {
    this.cache.delete(itemId);
  }

  /**
   * 清除所有缓存
   */
  clearAll(): void {
    this.cache.clear();
    this.preloadQueue.clear();
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * 获取预加载队列状态
   */
  isPreloading(category: OutfitCategory): boolean {
    return this.preloadQueue.has(category);
  }
}

// 导出单例实例
export const outfitLoader = new OutfitLoader();
