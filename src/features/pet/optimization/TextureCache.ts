/**
 * 纹理缓存管理
 * 使用 LRU 策略缓存纹理，减少重复加载
 */

export class TextureCache<T> {
  private cache = new Map<string, { texture: T; lastAccess: number }>();
  private readonly maxSize: number;
  private accessCounter = 0;

  /**
   * 创建纹理缓存
   * @param maxSize 缓存最大容量
   */
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * 从缓存中获取纹理
   * @param key 纹理键
   * @returns 纹理对象，如果不存在则返回 null
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // 更新访问时间
    entry.lastAccess = ++this.accessCounter;
    return entry.texture;
  }

  /**
   * 将纹理放入缓存
   * @param key 纹理键
   * @param texture 纹理对象
   */
  set(key: string, texture: T): void {
    // 如果已存在，更新访问时间
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.lastAccess = ++this.accessCounter;
      entry.texture = texture;
      return;
    }

    // 如果缓存已满，移除最久未访问的项
    if (this.cache.size >= this.maxSize) {
      this.evict();
    }

    this.cache.set(key, { texture, lastAccess: ++this.accessCounter });
  }

  /**
   * 检查缓存中是否存在指定键
   * @param key 纹理键
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 从缓存中移除指定纹理
   * @param key 纹理键
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 预加载纹理
   * @param key 纹理键
   * @param loadFn 加载函数
   */
  async preload(key: string, loadFn: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) {
      return this.cache.get(key)!.texture;
    }

    const texture = await loadFn();
    this.set(key, texture);
    return texture;
  }

  /**
   * 获取缓存中的纹理数量
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 移除最久未访问的项
   */
  private evict(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}