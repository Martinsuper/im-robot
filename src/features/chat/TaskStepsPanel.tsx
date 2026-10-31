import { useState } from "react";
import { getTaskSteps } from "./agentWire";
import { stepStatusLabel } from "./taskOutcomeModel";
import { toUserMessage } from "../../lib/errors";
import { useTranslation } from "../i18n/I18nProvider";
import "./taskSteps.css";

type NormalizedStep = { id: string; tool: string; status: string };

/** 归档段与实时段的步骤字段都从宽松 JSON 收敛，缺字段的条目直接丢弃。 */
function normalizeSteps(steps: unknown): NormalizedStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((entry, index): NormalizedStep => {
    const source = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const tool = typeof source.tool === "string" && source.tool ? source.tool
      : typeof source.name === "string" ? source.name : "";
    const id = typeof source.id === "string" && source.id ? source.id : `step-${index}`;
    const status = typeof source.status === "string" ? source.status : "";
    return { id, tool, status };
  }).filter((step) => step.tool);
}

/** 完整流水（doc 18 §9）：agent_get_task_steps(requestId, includeArchive=true) 的只读展示。 */
export function TaskStepsPanel({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<NormalizedStep[] | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (loading) return;
    setLoading(true);
    try {
      const result = await getTaskSteps(requestId, true);
      setSteps(normalizeSteps(result ? result.steps : null));
      setArchivedCount(Number(result?.archivedCount) || 0);
      setError("");
    } catch (cause) {
      setError(toUserMessage(cause, t("chat.task.steps.loadFailed", "流水读取失败，请重试。")));
    } finally {
      setLoading(false);
    }
  }
  return <details className="task-steps" onToggle={(event) => {
    if ((event.currentTarget as HTMLDetailsElement).open && steps === null) void load();
  }}>
    <summary>{t("chat.task.steps.button", "查看完整流水")}</summary>
    {loading && <p>{t("chat.task.steps.loading", "正在读取完整流水…")}</p>}
    {error && <p role="alert">{error}</p>}
    {steps !== null && !loading && <div>
      {archivedCount > 0 && <p>{t("chat.task.steps.archived", "含 {count} 条归档").replace("{count}", String(archivedCount))}</p>}
      {steps.length ? <ol className="task-steps__list" aria-label={t("chat.task.steps.button", "查看完整流水")}>
        {steps.map((step) => <li key={step.id}>{step.tool} · {stepStatusLabel(step.status)}</li>)}
      </ol> : <p>{t("chat.task.steps.empty", "没有已记录的工具步骤。")}</p>}
    </div>}
  </details>;
}
