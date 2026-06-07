/**
 * 渲染优化模块
 * 提供按需渲染、批量渲染和帧率控制
 */

export type RenderTask = () => void;

export interface RenderOptimizerOptions {
  targetFPS?: number;
  autoStart?: boolean;
}

export class RenderOptimizer {
  private taskQueue: RenderTask[] = [];
  private rafId: number | undefined;
  private lastFrameTime = 0;
  private frameInterval: number;
  private running = false;
  private dirty = false;

  /**
   * 创建渲染优化器
   * @param options 配置选项
   */
  constructor(options: RenderOptimizerOptions = {}) {
    const { targetFPS = 60, autoStart = false } = options;
    this.frameInterval = 1000 / targetFPS;

    if (autoStart) {
      this.start();
    }
  }

  /**
   * 调度渲染任务
   * @param task 渲染任务
   */
  schedule(task: RenderTask): void {
    this.taskQueue.push(task);
    this.dirty = true;

    if (!this.running) {
      this.start();
    }
  }

  /**
   * 批量调度多个渲染任务
   * @param tasks 渲染任务数组
   */
  scheduleBatch(tasks: RenderTask[]): void {
    this.taskQueue.push(...tasks);
    this.dirty = true;

    if (!this.running) {
      this.start();
    }
  }

  /**
   * 标记需要渲染
   */
  markDirty(): void {
    this.dirty = true;
    if (!this.running) {
      this.start();
    }
  }

  /**
   * 开始渲染循环
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }

  /**
   * 停止渲染循环
   */
  stop(): void {
    this.running = false;
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  /**
   * 清空任务队列
   */
  clearQueue(): void {
    this.taskQueue = [];
    this.dirty = false;
  }

  /**
   * 获取队列中的任务数量
   */
  get queueSize(): number {
    return this.taskQueue.length;
  }

  /**
   * 检查是否有待处理的任务
   */
  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * 设置目标帧率
   * @param fps 目标帧率
   */
  setTargetFPS(fps: number): void {
    this.frameInterval = 1000 / fps;
  }

  private loop = (time: number): void => {
    if (!this.running) return;

    const delta = time - this.lastFrameTime;

    if (delta >= this.frameInterval) {
      this.lastFrameTime = time - (delta % this.frameInterval);

      if (this.dirty && this.taskQueue.length > 0) {
        this.executeTasks();
      }
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  private executeTasks(): void {
    const tasks = this.taskQueue.splice(0, this.taskQueue.length);
    this.dirty = this.taskQueue.length > 0;

    for (const task of tasks) {
      task();
    }
  }
}