/**
 * 性能优化模块导出
 */

export { ObjectPool } from "./ObjectPool";
export type { ResetFunction } from "./ObjectPool";

export { TextureCache } from "./TextureCache";

export { PerformanceMonitor } from "./PerformanceMonitor";
export type {
  MemoryUsage,
  PerformanceAlert,
  AlertCallback,
} from "./PerformanceMonitor";

export { RenderOptimizer } from "./RenderOptimizer";
export type { RenderTask, RenderOptimizerOptions } from "./RenderOptimizer";