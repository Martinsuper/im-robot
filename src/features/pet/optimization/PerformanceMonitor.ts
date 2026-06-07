/**
 * 性能监控模块
 * 提供 FPS 监控、内存使用监控和性能告警
 */

export interface MemoryUsage {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export type PerformanceAlert = {
  type: "fps" | "memory";
  value: number;
  threshold: number;
  timestamp: number;
};

export type AlertCallback = (alert: PerformanceAlert) => void;

export class PerformanceMonitor {
  private fps = 0;
  private frameCount = 0;
  private lastFrameTime = performance.now();
  private memoryUsage: MemoryUsage | null = null;
  private alerts: AlertCallback[] = [];
  private fpsThreshold = 30;
  private memoryThreshold = 0.8;
  private monitoring = false;
  private fpsInterval: number | undefined;
  private memoryInterval: number | undefined;

  /**
   * 开始性能监控
   * @param fpsUpdateInterval FPS 更新间隔（毫秒）
   * @param memoryUpdateInterval 内存更新间隔（毫秒）
   */
  start(
    fpsUpdateInterval = 1000,
    memoryUpdateInterval = 5000
  ): void {
    if (this.monitoring) return;
    this.monitoring = true;

    // 启动 FPS 监控
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.updateFPS();

    this.fpsInterval = window.setInterval(() => {
      this.updateFPS();
    }, fpsUpdateInterval);

    // 启动内存监控
    this.updateMemoryUsage();
    this.memoryInterval = window.setInterval(() => {
      this.updateMemoryUsage();
    }, memoryUpdateInterval);
  }

  /**
   * 停止性能监控
   */
  stop(): void {
    this.monitoring = false;
    if (this.fpsInterval) {
      window.clearInterval(this.fpsInterval);
      this.fpsInterval = undefined;
    }
    if (this.memoryInterval) {
      window.clearInterval(this.memoryInterval);
      this.memoryInterval = undefined;
    }
  }

  /**
   * 获取当前 FPS
   */
  getFPS(): number {
    return this.fps;
  }

  /**
   * 获取当前内存使用情况
   */
  getMemoryUsage(): MemoryUsage | null {
    return this.memoryUsage;
  }

  /**
   * 设置 FPS 告警阈值
   * @param threshold FPS 低于此值时触发告警
   */
  setFPSThreshold(threshold: number): void {
    this.fpsThreshold = threshold;
  }

  /**
   * 设置内存使用告警阈值
   * @param threshold 内存使用率高于此值时触发告警（0-1）
   */
  setMemoryThreshold(threshold: number): void {
    this.memoryThreshold = threshold;
  }

  /**
   * 注册性能告警回调
   * @param callback 告警回调函数
   */
  onAlert(callback: AlertCallback): void {
    this.alerts.push(callback);
  }

  /**
   * 移除性能告警回调
   * @param callback 要移除的回调函数
   */
  removeAlert(callback: AlertCallback): void {
    this.alerts = this.alerts.filter((cb) => cb !== callback);
  }

  /**
   * 手动记录一帧（用于非 requestAnimationFrame 场景）
   */
  recordFrame(): void {
    this.frameCount++;
  }

  private updateFPS(): void {
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    if (elapsed > 0) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount = 0;
      this.lastFrameTime = now;

      // 检查 FPS 告警
      if (this.fps < this.fpsThreshold && this.fps > 0) {
        this.triggerAlert({
          type: "fps",
          value: this.fps,
          threshold: this.fpsThreshold,
          timestamp: Date.now(),
        });
      }
    }
  }

  private updateMemoryUsage(): void {
    // 尝试获取真实的内存使用情况
    const memory = (performance as any).memory;
    if (memory) {
      this.memoryUsage = {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };

      // 检查内存使用告警
      if (memory.totalJSHeapSize > 0) {
        const usageRatio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
        if (usageRatio > this.memoryThreshold) {
          this.triggerAlert({
            type: "memory",
            value: usageRatio,
            threshold: this.memoryThreshold,
            timestamp: Date.now(),
          });
        }
      }
    } else {
      // 如果不支持 performance.memory，提供模拟数据
      this.memoryUsage = {
        usedJSHeapSize: 0,
        totalJSHeapSize: 0,
        jsHeapSizeLimit: 0,
      };
    }
  }

  private triggerAlert(alert: PerformanceAlert): void {
    for (const callback of this.alerts) {
      callback(alert);
    }
  }
}