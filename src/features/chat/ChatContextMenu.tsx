import { useEffect, useState, type RefObject } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Clock, FolderOpen, FolderPlus, Star, X } from "lucide-react";
import type { HtmlFavorite } from "./htmlFavorites";
import type { ProjectInfo } from "./agentTypes";
import { isTauriRuntime } from "../app/appRuntime";
import { cancelScheduledTask, createScheduledTask, listScheduledTasks, invokeV2, type ScheduledTaskInput, type ScheduledTaskRecord } from "./agentWire";
import { useTranslation } from "../i18n/I18nProvider";

type Props = {
  cwd: string;
  disabled: boolean;
  open: boolean;
  projectId?: string;
  projectName?: string;
  onToggle: () => void;
  onChoose: () => void;
  onSelectProject: (project: ProjectInfo) => void;
  favoritesOpen: boolean;
  onToggleFavorites: () => void;
  favoritesButtonRef: RefObject<HTMLButtonElement | null>;
  favorites: HtmlFavorite[];
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
};

function isProjectInfo(value: unknown): value is ProjectInfo {
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry) && typeof entry?.id === "string" && typeof entry?.path === "string";
}

function isScheduledTask(value: unknown): value is ScheduledTaskRecord {
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry) && typeof entry?.id === "string" && typeof entry?.prompt === "string";
}

/** 菜单里只展示/取消 pending 项；status 缺省视为 pending。 */
function isPendingTask(item: ScheduledTaskRecord): boolean {
  return (item.status ?? "pending") === "pending";
}

/** `<input type="datetime-local">` 的取值与本地时间互转（与 TodayTab 同一模式）。 */
function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 默认给下一个整点，减少一次调整。 */
function defaultScheduleTime(): string {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return toDateTimeLocalValue(date);
}

/** 宿主返回的 scheduledAt 可能是 ISO 字符串或 epoch（秒/毫秒），渲染前统一收敛。 */
function formatScheduleTime(value: unknown): string {
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value)
    : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "—";
}

/** 最近项目 + 新建项目 + 定时委托；目录选择仍保留为可选的轻量路径（doc 04 §4.6、doc 18 §9）。 */
export function ChatContextMenu({
  cwd,
  disabled,
  open,
  projectId,
  projectName,
  onToggle,
  onChoose,
  onSelectProject,
  favoritesOpen,
  onToggleFavorites,
  favoritesButtonRef,
  favorites,
  onSelect,
  onRemove,
}: Props) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectInfo[]>();
  const [projectError, setProjectError] = useState("");
  const [creating, setCreating] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleProjectId, setScheduleProjectId] = useState("");
  const [scheduleAt, setScheduleAt] = useState(defaultScheduleTime);
  const [scheduled, setScheduled] = useState<ScheduledTaskRecord[]>();
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const directory = projectName || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  useEffect(() => {
    if (!open || !isTauriRuntime) return;
    let active = true;
    invokeV2<ProjectInfo[]>("project_list").then((items) => {
      if (!active) return;
      const list = Array.isArray(items) ? items.filter(isProjectInfo) : [];
      list.sort((left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0));
      setProjects(list);
      setProjectError("");
    }).catch(() => {
      if (active) setProjectError(t("chat.project.listFailed", "项目列表读取失败，仍可选择工作目录。"));
    });
    return () => { active = false; };
  }, [open, t]);

  useEffect(() => {
    if (!open || !scheduleOpen || !isTauriRuntime) return;
    let active = true;
    listScheduledTasks().then((items) => {
      if (!active) return;
      setScheduled(Array.isArray(items) ? items.filter(isScheduledTask).filter(isPendingTask) : []);
      setScheduleError("");
    }).catch(() => {
      if (active) setScheduleError(t("chat.schedule.listFailed", "定时委托读取失败，请重试。"));
    });
    return () => { active = false; };
  }, [open, scheduleOpen, t]);

  async function createProject() {
    if (creating) return;
    try {
      const path = await pickDirectory({ directory: true, multiple: false, title: t("chat.project.pickTitle", "选择项目目录") });
      if (typeof path !== "string") return;
      setCreating(true);
      const created = await invokeV2<ProjectInfo>("project_create", { path });
      if (isProjectInfo(created)) onSelectProject(created);
    } catch {
      setProjectError(t("chat.project.createFailed", "新建项目失败，请重试。"));
    } finally {
      setCreating(false);
    }
  }

  async function createScheduled() {
    if (scheduleBusy) return;
    const prompt = schedulePrompt.trim();
    const when = new Date(scheduleAt);
    if (!prompt || Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setScheduleError(t("chat.schedule.invalidTime", "请填写提示词并选择将来的时间。"));
      return;
    }
    setScheduleBusy(true);
    setScheduleError("");
    try {
      const picked = projects?.find((project) => project.id === scheduleProjectId);
      const payload: ScheduledTaskInput = { prompt, scheduledAt: when.toISOString() };
      if (picked) payload.projectId = picked.id;
      else if (cwd) payload.workspace = cwd;
      await createScheduledTask(payload);
      setSchedulePrompt("");
      setScheduleStatus(t("chat.schedule.created", "定时委托已创建。"));
      window.setTimeout(() => setScheduleStatus(""), 4000);
      const items = await listScheduledTasks().catch(() => undefined);
      if (items) setScheduled(Array.isArray(items) ? items.filter(isScheduledTask).filter(isPendingTask) : []);
    } catch {
      setScheduleError(t("chat.schedule.createFailed", "定时委托创建失败，请重试。"));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function cancelScheduled(id: string) {
    try {
      await cancelScheduledTask(id);
      setScheduled((items) => items?.filter((item) => item.id !== id));
      setScheduleError("");
    } catch {
      setScheduleError(t("chat.schedule.cancelFailed", "取消失败，请重试。"));
    }
  }

  return (
    <>
      <div className="bubble-context-bar">
        <button
          type="button"
          className="bubble-context-toggle"
          data-testid="chat-context-toggle"
          aria-expanded={open}
          aria-controls="bubble-context-options"
          onClick={onToggle}
        >
          <FolderOpen size={13} />
          <span>{directory || "工作空间与收藏"}</span>
          <ChevronDown size={12} />
        </button>
        <span className="bubble-input-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      <div
        id="bubble-context-options"
        className="chat-workspace"
        aria-label="对话上下文"
        hidden={!open}
      >
        <button
          type="button"
          data-testid="workspace-directory"
          className="chat-workspace__directory"
          title={cwd || "需要操作本地文件时再选择文件夹"}
          disabled={disabled}
          onClick={onChoose}
        >
          <FolderOpen size={13} /> {directory || "选择工作目录（可选）"}
        </button>
        <button
          ref={favoritesButtonRef}
          type="button"
          className="chat-workspace__directory"
          title="收藏的 HTML 卡片"
          onClick={onToggleFavorites}
          aria-expanded={favoritesOpen}
        >
          <Star size={13} /> 收藏卡片
          {favorites.length ? ` · ${favorites.length}` : ""}
        </button>
      </div>
      {open && (
        <div className="bubble-projects" aria-label={t("chat.project.menuLabel", "项目")}>
          <button
            type="button"
            className="bubble-projects__create"
            onClick={() => void createProject()}
            disabled={creating}
          >
            <FolderPlus size={13} /> {t("chat.project.new", "新建项目")}
          </button>
          {projectError && <p role="alert">{projectError}</p>}
          {projects === undefined && !projectError && isTauriRuntime && <p>{t("chat.project.loading", "正在读取项目…")}</p>}
          {projects?.length === 0 && <p>{t("chat.project.empty", "还没有项目，选择目录即可新建。")}</p>}
          {projects?.map((project) => <button
            key={project.id}
            type="button"
            className={`bubble-projects__item${project.id === projectId ? " is-active" : ""}`}
            title={project.path}
            aria-pressed={project.id === projectId}
            onClick={() => onSelectProject(project)}
          >
            {project.name || project.path.split(/[\\/]/).filter(Boolean).pop() || project.path}
          </button>)}
        </div>
      )}
      {open && (
        <div className="bubble-schedule" aria-label={t("chat.schedule.aria", "定时委托")}>
          <button
            type="button"
            className="bubble-schedule__toggle"
            aria-expanded={scheduleOpen}
            data-testid="schedule-toggle"
            onClick={() => setScheduleOpen((value) => !value)}
          >
            <Clock size={13} /> {t("chat.schedule.title", "定时委托")}
            {scheduled?.length ? ` · ${scheduled.length}` : ""}
          </button>
          {scheduleOpen && (
            <div className="bubble-schedule__form">
              <label>
                {t("chat.schedule.promptLabel", "任务提示词")}
                <textarea rows={2} maxLength={2000} value={schedulePrompt}
                  aria-label={t("chat.schedule.promptLabel", "任务提示词")}
                  placeholder={t("chat.schedule.promptPlaceholder", "到点后要交给 Piko 的事…")}
                  onChange={(event) => setSchedulePrompt(event.target.value)} />
              </label>
              <label>
                {t("chat.schedule.projectLabel", "项目")}
                <select value={scheduleProjectId} aria-label={t("chat.schedule.projectLabel", "项目")}
                  onChange={(event) => setScheduleProjectId(event.target.value)}>
                  <option value="">{t("chat.schedule.currentWorkspace", "当前工作目录")}</option>
                  {projects?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name || project.path.split(/[\\/]/).filter(Boolean).pop() || project.path}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("chat.schedule.timeLabel", "执行时间")}
                <input type="datetime-local" value={scheduleAt} aria-label={t("chat.schedule.timeLabel", "执行时间")}
                  onChange={(event) => setScheduleAt(event.target.value)} />
              </label>
              <small>{t("chat.schedule.policyHint", "自主档位沿用项目默认配置。")}</small>
              <button type="button" disabled={scheduleBusy || !schedulePrompt.trim()}
                onClick={() => void createScheduled()}>
                {t("chat.schedule.submit", "创建定时委托")}
              </button>
              {scheduleStatus && <p role="status">{scheduleStatus}</p>}
              {scheduleError && <p role="alert">{scheduleError}</p>}
              <div className="bubble-schedule__pending">
                <strong>{t("chat.schedule.pendingTitle", "待执行")}</strong>
                {scheduled === undefined ? null : scheduled.length === 0 ? (
                  <p>{t("chat.schedule.pendingEmpty", "暂无待执行的定时委托。")}</p>
                ) : scheduled.map((item) => (
                  <div key={item.id} className="bubble-schedule__item">
                    <span title={item.prompt}>{item.prompt}</span>
                    <time>{formatScheduleTime(item.scheduledAt)}</time>
                    <button type="button" aria-label={`${t("chat.schedule.cancel", "取消")}：${item.prompt}`}
                      onClick={() => void cancelScheduled(item.id)}>
                      {t("chat.schedule.cancel", "取消")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {open && favoritesOpen && (
        <div className="bubble-favorites" aria-label="收藏的 HTML 卡片">
          {favorites.length === 0 ? (
            <p>还没有收藏，在任意 HTML 卡片头部点 ★ 即可收藏</p>
          ) : (
            favorites.map((favorite) => (
              <div key={favorite.id} className="bubble-favorites__item">
                <button
                  type="button"
                  className="bubble-favorites__title"
                  title={favorite.html}
                  onClick={() => onSelect(favorite.id)}
                >
                  {favorite.title}
                </button>
                <span className="bubble-favorites__actions">
                  <button
                    type="button"
                    title="删除"
                    onClick={() => onRemove(favorite.id)}
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
