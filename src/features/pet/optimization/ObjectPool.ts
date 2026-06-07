/**
 * 通用对象池实现
 * 用于复用对象，减少频繁的内存分配和垃圾回收
 */

export type ResetFunction<T> = (obj: T) => void;

export class ObjectPool<T> {
  private pool: T[] = [];
  private readonly createFn: () => T;
  private readonly resetFn: ResetFunction<T>;
  private readonly maxSize: number;

  /**
   * 创建对象池
   * @param createFn 创建新对象的函数
   * @param resetFn 重置对象状态的函数
   * @param initialSize 初始池大小
   * @param maxSize 池的最大容量
   */
  constructor(
    createFn: () => T,
    resetFn: ResetFunction<T>,
    initialSize = 10,
    maxSize = 100
  ) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.maxSize = maxSize;

    // 预创建初始对象
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.createFn());
    }
  }

  /**
   * 从池中获取一个对象
   * @returns 可用对象
   */
  acquire(): T {
    let obj: T;
    if (this.pool.length > 0) {
      obj = this.pool.pop()!;
    } else {
      obj = this.createFn();
    }
    return obj;
  }

  /**
   * 将对象归还到池中
   * @param obj 要归还的对象
   */
  release(obj: T): void {
    this.resetFn(obj);
    if (this.pool.length < this.maxSize) {
      this.pool.push(obj);
    }
  }

  /**
   * 获取当前池中的对象数量
   */
  get size(): number {
    return this.pool.length;
  }

  /**
   * 清空对象池
   */
  clear(): void {
    this.pool = [];
  }
}