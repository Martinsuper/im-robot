import { useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings } from "../../types/appTypes";
import { defaultAppSettings } from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";

/**
 * 面板的单一 settings 存储（对齐 00 §5.8「单一数据源原则」）。
 *
 * 为什么需要它：拆分后的三个 Tab（今天 / 记录 / 设置）都要读设置。若各自
 * `get_settings` + 各自 `listen("settings-updated")`，同一次修改会被处理三遍，
 * 而且三份副本会各自漂移——正是本次重构要消灭的东西。
 *
 * 这里在**模块级**只保留一份缓存与一个事件订阅，所有消费者通过
 * `useAppSettings()` 读同一份快照。
 *
 * 写入约定：字段级的持久化（含 debounce 与失败回滚）由「设置」Tab 用
 * `useAutoSave` 负责，因为它知道每个控件属于哪个命令组。写入成功后调
 * `applyServer()` 把服务端返回值推进缓存；失败时不要推进。
 */

let cache: AppSettings = defaultAppSettings;
let loadPromise: Promise<void> | undefined;
let eventSubscription: UnlistenFn | undefined;
const listeners = new Set<() => void>();

function publish(next: AppSettings) {
  cache = next;
  for (const listener of listeners) listener();
}

function ensureLoaded(): Promise<void> {
  loadPromise ??= runCommand<AppSettings>("get_settings", undefined, defaultAppSettings)
    .then(publish)
    .catch((error: unknown) => {
      // 读取失败时把 promise 清掉，让下一次挂载可以重试；否则一次失败会永久生效。
      loadPromise = undefined;
      throw error;
    });
  return loadPromise;
}

function ensureEventSubscription() {
  if (eventSubscription || !isTauriRuntime) return;
  // 订阅与面板进程同生命周期，因此刻意不做 unlisten：
  // 对已注销的监听再调一次 unlisten 会抛未处理的 rejection（见 09 文档 NEW-15）。
  void listen<AppSettings>("settings-updated", (event) => publish(event.payload)).then((unlisten) => {
    eventSubscription = unlisten;
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensureEventSubscription();
  void ensureLoaded().catch((error: unknown) => {
    console.error("[settings] 读取设置失败", error);
  });
  return () => {
    listeners.delete(listener);
  };
}

export interface AppSettingsApi {
  settings: AppSettings;
  /** 把服务端返回的设置推进缓存并广播给所有订阅者。 */
  applyServer: (next: AppSettings) => void;
  /** 强制重新拉取（错误重试用）。 */
  reload: () => Promise<void>;
}

export function useAppSettings(): AppSettingsApi {
  const settings = useSyncExternalStore(
    subscribe,
    () => cache,
    () => defaultAppSettings,
  );
  return {
    settings,
    applyServer: publish,
    reload: () => {
      loadPromise = undefined;
      return ensureLoaded();
    },
  };
}
