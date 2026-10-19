import { useTranslation } from "../../features/i18n/I18nProvider";
import { invokeCommand } from "../../generated/ipc";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../features/app/appRuntime";
export function DataRestoreStatus() {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [temporaryMemory, setTemporaryMemory] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime) return;
    void invokeCommand("get_data_health", {})
      .then((health) => setTemporaryMemory(health?.memoryPersistent === false))
      .catch((error) => console.error("[data-health]", error));
    const subscription = listen("data-restore-pending", () => setPending(true));
    void subscription.catch((error) => console.error("[restore]", error));
    return () => {
      void subscription.then((dispose) => dispose()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const block = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [pending]);
  if (!pending)
    return temporaryMemory ? (
      <aside className="persistence-error" role="alert">
        {t(
          "data.memory.temporary",
          "记忆仅保存在本次会话，重启后会丢失。请检查磁盘空间和数据目录权限。",
        )}
      </aside>
    ) : null;
  return (
    <div className="data-restore-overlay" role="alert">
      {t("data.restore.pending", "正在恢复并重启 Piko，请稍候…")}
    </div>
  );
}
