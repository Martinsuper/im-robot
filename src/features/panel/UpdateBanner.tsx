import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useAppSettings } from "../app/settingsStore";
import { useTranslation } from "../i18n/I18nProvider";
import type { UpdateStatus } from "../../types/appTypes";

/**
 * 半自动更新的提醒横幅：Rust 每日定时检查发现新版本后 emit "update-available"。
 * 先订阅事件再对账缓存（与 soul 消息同款顺序），避免错过订阅前发出的提醒。
 * 「跳过此版本」写入设置后自动提醒静默，设置页手动检查不受影响。
 */
export function UpdateBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const [status, setStatus] = useState<UpdateStatus>();
  const [dismissed, setDismissed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const subscription = isTauriRuntime
      ? listen<UpdateStatus>("update-available", ({ payload }) => {
          if (mounted.current) setStatus(payload);
        })
      : Promise.resolve(() => {});
    void runCommand("get_last_update_status")
      .then((last) => {
        if (mounted.current && last) setStatus(last);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      void subscription.then((dispose) => dispose()).catch(() => {});
    };
  }, []);
  if (
    !status?.available ||
    dismissed ||
    status.latestVersion === settings.skippedUpdateVersion
  )
    return null;
  async function skip() {
    if (!status) return;
    try {
      await runCommand("update_skipped_update_version", {
        version: status.latestVersion,
      });
    } catch {
      // 写入失败也按本会话跳过，避免横幅反复出现。
    }
    setDismissed(true);
  }
  return (
    <aside className="update-banner" role="status">
      <span>
        {t("update.available", "发现新版本")}：v{status.latestVersion}
      </span>
      <span className="update-banner__actions">
        <button type="button" onClick={onOpenSettings}>
          {t("update.viewDetails", "查看详情")}
        </button>
        <button type="button" className="text-action" onClick={() => void skip()}>
          {t("update.skipVersion", "跳过此版本")}
        </button>
      </span>
    </aside>
  );
}
