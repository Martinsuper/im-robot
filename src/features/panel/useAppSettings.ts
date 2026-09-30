import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { defaultAppSettings } from "../app/appShared";
import { isTauriRuntime, reportCommandError, runCommand } from "../app/appRuntime";
import type { AppSettings } from "../../types/appTypes";

/**
 * 面板的设置状态：加载一次后跟随 settings-updated 事件保持同步。
 * 之前加载与事件更新是两份各 11 个 setXxx 的重复代码，极易漂移。
 */
export function useAppSettings(onLoaded?: (settings: AppSettings) => void) {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((loaded) => {
      setSettings(loaded);
      onLoaded?.(loaded);
    }).catch(reportCommandError("get_settings"));
    if (!isTauriRuntime) return;
    const unlisten = listen<AppSettings>("settings-updated", (event) => {
      setSettings(event.payload);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
    // onLoaded 仅在挂载加载时触发一次，刻意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [settings, setSettings] as const;
}
