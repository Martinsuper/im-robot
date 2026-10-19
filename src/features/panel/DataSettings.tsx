import { useTranslation } from "../i18n/I18nProvider";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invokeCommand, type CommandMap } from "../../generated/ipc";
import { isTauriRuntime } from "../app/appRuntime";
import { flushPersistentState } from "../../lib/persistentState";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";

type Snapshot = CommandMap["create_data_snapshot"]["result"];
type Worker = CommandMap["background_status"]["result"][number];
export function DataSettings() {
  const toast = useToast();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [restore, setRestore] = useState<Snapshot>();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [health, setHealth] =
    useState<CommandMap["get_data_health"]["result"]>();
  useEffect(() => {
    if (isTauriRuntime) {
      void invokeCommand("background_status", {})
        .then(setWorkers)
        .catch((error) => toast.error(toUserMessage(error)));
      void invokeCommand("get_data_health", {})
        .then(setHealth)
        .catch((error) => toast.error(toUserMessage(error)));
    }
  }, [toast]);
  async function create() {
    setBusy(true);
    try {
      await flushPersistentState();
      const result = await invokeCommand("create_data_snapshot", {});
      setSnapshot(result);
      toast.success(t("data.snapshot.saved", "完整备份已保存"));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function choose() {
    try {
      const directory = await open({
        directory: true,
        multiple: false,
        title: t("data.snapshot.chooseDirectory", "选择完整备份文件夹"),
      });
      if (typeof directory === "string")
        setRestore(await invokeCommand("preview_data_snapshot", { directory }));
    } catch (error) {
      toast.error(toUserMessage(error));
    }
  }
  async function confirm() {
    if (!restore) return;
    setBusy(true);
    try {
      await flushPersistentState();
      await invokeCommand("restore_data_snapshot", {
        directory: restore.directory,
      });
    } catch (error) {
      toast.error(toUserMessage(error));
      setBusy(false);
    }
  }
  return (
    <section className="panel-card">
      <h2>{t("data.snapshot.title", "完整备份与恢复")}</h2>
      <p className="settings-note">
        {t(
          "data.snapshot.description",
          "包含对话、日程、记忆和宠物成长；不包含 API Key、下载模型和工作目录原文件。正在执行任务时请稍后再试。",
        )}
      </p>
      <button
        type="button"
        disabled={!isTauriRuntime || busy}
        onClick={() => void create()}
      >
        {t("data.snapshot.create", "创建完整备份")}
      </button>
      <button
        type="button"
        disabled={!isTauriRuntime || busy}
        onClick={() => void choose()}
      >
        {t("data.snapshot.choose", "恢复完整备份…")}
      </button>
      {snapshot && (
        <p role="status">
          {t("data.snapshot.savedDetails", "已备份 {count} 个文件：{directory}")
            .replace("{count}", String(snapshot.fileCount))
            .replace("{directory}", snapshot.directory)}
        </p>
      )}
      {restore && (
        <div
          className="settings-subgroup"
          role="region"
          aria-label={t("data.snapshot.confirmLabel", "恢复确认")}
        >
          <p>
            {t(
              "data.snapshot.confirmDescription",
              "将恢复 {count} 个文件并重启 Piko。恢复前会自动备份当前数据，系统中的日历不会被改动。",
            ).replace("{count}", String(restore.fileCount))}
          </p>
          <button type="button" disabled={busy} onClick={() => void confirm()}>
            {t("data.snapshot.confirm", "确认恢复并重启")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRestore(undefined)}
          >
            {t("data.snapshot.cancel", "取消恢复")}
          </button>
        </div>
      )}
      <details>
        <summary>{t("data.diagnostics.title", "后台任务诊断")}</summary>
        <button
          type="button"
          disabled={!isTauriRuntime}
          onClick={() => {
            void invokeCommand("background_status", {})
              .then(setWorkers)
              .catch((error) => toast.error(toUserMessage(error)));
          }}
        >
          {t("data.diagnostics.refresh", "刷新任务状态")}
        </button>
        {health && (
          <p>
            {t("data.diagnostics.sqlite", "数据库锁等待（微秒）")}：
            {health.sqlite.waitMicros} ·{" "}
            {t("data.diagnostics.json", "文件锁等待（微秒）")}：
            {health.jsonLockWaitMicros}
          </p>
        )}
        {workers.map((worker) => (
          <p key={worker.name}>
            {worker.name}：{worker.state}
            {worker.lastError ? ` · ${worker.lastError}` : ""}
          </p>
        ))}
      </details>
    </section>
  );
}
