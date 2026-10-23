import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime as desktop } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { useTranslation } from "../i18n/I18nProvider";

type ExtractionStatus = {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: number;
  processedCount: number;
  pendingCount: number;
};

export function MemoryExtractionControls() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    async function refresh() {
      try {
        const next = await invoke<ExtractionStatus>(
          "get_memory_extraction_status",
        );
        if (active) setStatus(next);
      } catch (reason) {
        if (active) setError(toUserMessage(reason));
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const listener = listen("memories-updated", () => void refresh());
    void listener.catch((reason) => {
      if (active) setError(toUserMessage(reason));
    });
    return () => {
      active = false;
      window.clearInterval(timer);
      void listener.then(
        (dispose) => dispose(),
        () => {},
      );
    };
  }, []);

  async function configure(enabled: boolean, intervalMinutes: number) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setStatus(
        await invoke<ExtractionStatus>("configure_memory_extraction", {
          enabled,
          intervalMinutes,
        }),
      );
    } catch (reason) {
      setError(toUserMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function extract() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const count = await invoke<number>("extract_memories_now");
      setStatus(await invoke<ExtractionStatus>("get_memory_extraction_status"));
      setMessage(
        t(
          "memory.extraction.result",
          "新增 {count} 条候选记忆，请在待确认中审核。",
        ).replace("{count}", String(count)),
      );
    } catch (reason) {
      setError(toUserMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const unavailable = !desktop || !status || busy;
  return (
    <section
      className="memory-extraction memory-extraction--compact"
      aria-label={t("memory.extraction.title", "自动提取记忆")}
    >
      <div className="memory-extraction__bar">
        <details className="memory-extraction__settings">
          <summary>{t("memory.extraction.settings", "自动提取设置")}</summary>
          <div className="memory-extraction__config">
            <label>
              <input
                type="checkbox"
                checked={status?.enabled ?? false}
                disabled={unavailable}
                onChange={(event) =>
                  void configure(
                    event.currentTarget.checked,
                    status?.intervalMinutes ?? 30,
                  )
                }
              />
              {t("memory.extraction.enable", "定期从对话提取记忆")}
            </label>
            <label>
              {t("memory.extraction.interval", "提取间隔")}
              <select
                aria-label={t("memory.extraction.interval", "提取间隔")}
                value={status?.intervalMinutes ?? 30}
                disabled={unavailable}
                onChange={(event) =>
                  void configure(
                    status?.enabled ?? true,
                    Number(event.currentTarget.value),
                  )
                }
              >
                {[
                  5,
                  15,
                  30,
                  60,
                  360,
                  1440,
                  ...(status &&
                  ![5, 15, 30, 60, 360, 1440].includes(status.intervalMinutes)
                    ? [status.intervalMinutes]
                    : []),
                ].map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} {t("memory.extraction.minutes", "分钟")}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {t(
                "memory.extraction.description",
                "定期从用户对话原文提取偏好和项目事实。知识库每日整理时可自动收录明确的非敏感内容；敏感或疑似冲突的候选留待确认。未配置 AI 时使用句式规则。“立即提取”会重新分析历史。",
              )}
            </p>
            {status && (
              <p>
                {t("memory.extraction.lastRun", "上次提取：")}
                {status.lastRunAt
                  ? new Date(status.lastRunAt * 1000).toLocaleString()
                  : t("memory.extraction.notYet", "尚未运行")}
              </p>
            )}
          </div>
        </details>
        <button
          type="button"
          disabled={unavailable}
          onClick={() => void extract()}
        >
          {busy
            ? t("memory.extraction.working", "处理中…")
            : t("memory.extraction.now", "立即提取")}
        </button>
      </div>
      {!desktop && (
        <p>
          {t("memory.extraction.desktopOnly", "请在桌面应用中设置自动提取。")}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
