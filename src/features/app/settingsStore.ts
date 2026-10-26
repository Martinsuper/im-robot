import { useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, QuietMode, Theme } from "../../types/appTypes";
import { defaultAppSettings } from "./appShared";
import { isTauriRuntime, runCommand } from "./appRuntime";

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
let eventSubscription: Promise<UnlistenFn> | undefined;
let revision = 0;
let loadGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: AppSettings) {
  revision += 1;
  cache = next;
  for (const listener of listeners) listener();
}

async function ensureLoaded(): Promise<void> {
  // Subscribe before reading so updates cannot fall in the registration gap.
  if (isTauriRuntime) await ensureEventSubscription();
  if (!loadPromise) {
    const startedAt = revision;
    const generation = ++loadGeneration;
    loadPromise = runCommand(
      "get_settings",
      undefined,
      defaultAppSettings,
    )
      .then((next) => {
        if (generation === loadGeneration && revision === startedAt)
          publish(parseAppSettings(next));
      })
      .catch((error: unknown) => {
        if (generation === loadGeneration) loadPromise = undefined;
        throw error;
      });
  }
  return loadPromise;
}

function ensureEventSubscription(): Promise<UnlistenFn> {
  eventSubscription ??= listen<unknown>("settings-updated", (event) =>
    publish(parseAppSettings(event.payload)),
  ).catch((error: unknown) => {
    eventSubscription = undefined;
    throw error;
  });
  return eventSubscription;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void ensureLoaded().catch((error: unknown) => {
    console.error("[settings] 读取设置失败", error);
  });
  return () => {
    listeners.delete(listener);
  };
}

const quietModes: readonly QuietMode[] = ["active", "balanced", "minimal"];
const themes: readonly Theme[] = ["sage", "blue", "peach"];

/**
 * IPC 返回的设置是生成的宽类型（字面量联合退化为 string 等），进入缓存前统一
 * 收窄：非法或缺失字段回落默认值，消费方拿到的始终是合法 AppSettings。
 */
export function parseAppSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ai = source.ai && typeof source.ai === "object" ? (source.ai as Record<string, unknown>) : {};
  return {
    ...defaultAppSettings,
    ...source,
    quietMode: quietModes.includes(source.quietMode as QuietMode)
      ? (source.quietMode as QuietMode)
      : defaultAppSettings.quietMode,
    theme: themes.includes(source.theme as Theme)
      ? (source.theme as Theme)
      : defaultAppSettings.theme,
    ai: { ...defaultAppSettings.ai, ...ai },
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
      loadGeneration += 1;
      loadPromise = undefined;
      return ensureLoaded();
    },
  };
}
