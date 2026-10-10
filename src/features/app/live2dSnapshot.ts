import { useCallback, useSyncExternalStore } from "react";

/**
 * 每窗口唯一的 Live2D 快照提供者。
 *
 * 每个 Tauri 窗口是独立 webview（独立 JS 上下文），因此模块级单例即"每窗口一份"。
 * 窗口内只允许一个真实 Live2D 实例（live variant）注册为快照源，其余 PetSprite
 * （snapshot variant）订阅快照 dataURL，用 <img> 渲染静态影像，从而把单窗口的
 * WebGL 上下文数量收敛到 1。
 */

export type Live2DPetVariant = "live" | "snapshot";

type Live2DSnapshotSource = () => HTMLCanvasElement | null;
type Live2DSnapshotListener = () => void;

const SNAPSHOT_INTERVAL_MS = 500;

let snapshotSource: Live2DSnapshotSource | null = null;
let snapshotTimer: number | null = null;
let latestSnapshot: string | null = null;
let exportInFlight = false;
const listeners = new Set<Live2DSnapshotListener>();

function canExportNow() {
  // 窗口隐藏（最小化/遮挡）时暂停导出，避免无意义的 GPU 读取与编码开销
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function exportSnapshot() {
  if (exportInFlight || !snapshotSource || listeners.size === 0 || !canExportNow()) return;
  const canvas = snapshotSource();
  if (!canvas || typeof canvas.toDataURL !== "function") return;
  exportInFlight = true;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl && dataUrl !== latestSnapshot) {
      latestSnapshot = dataUrl;
      for (const listener of listeners) listener();
    }
  } catch (error) {
    console.warn("[Live2D] snapshot export failed:", error);
  } finally {
    exportInFlight = false;
  }
}

function startSnapshotTimer() {
  if (snapshotTimer !== null || !snapshotSource || listeners.size === 0) return;
  snapshotTimer = window.setInterval(exportSnapshot, SNAPSHOT_INTERVAL_MS);
}

function stopSnapshotTimer() {
  if (snapshotTimer === null) return;
  window.clearInterval(snapshotTimer);
  snapshotTimer = null;
}

/**
 * 真实 Live2D 实例在 ready 后注册画布读取器；卸载或重建时以 null 注销。
 * 注销后保留 latestSnapshot，模型切换的空档期订阅者可继续显示上一帧，避免闪烁。
 */
export function registerLive2DSnapshotSource(source: Live2DSnapshotSource | null) {
  snapshotSource = source;
  if (snapshotSource) {
    startSnapshotTimer();
  } else {
    stopSnapshotTimer();
  }
}

export function subscribeLive2DSnapshot(listener: Live2DSnapshotListener) {
  listeners.add(listener);
  startSnapshotTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopSnapshotTimer();
  };
}

/** snapshot variant 的 PetSprite 订阅快照 dataURL；enabled=false 时不参与订阅。 */
export function useLive2DSnapshotUrl(enabled: boolean) {
  const subscribe = useCallback(
    (onStoreChange: Live2DSnapshotListener) =>
      enabled ? subscribeLive2DSnapshot(onStoreChange) : () => undefined,
    [enabled],
  );
  const getSnapshot = useCallback(() => (enabled ? latestSnapshot : null), [enabled]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
