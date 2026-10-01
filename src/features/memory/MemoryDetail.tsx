import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MemoryItem,
  MemoryRelation,
  RELATION_LABELS,
  MEMORY_TYPE_LABELS,
  MEMORY_SOURCE_LABELS,
} from "./memoryTypes";
import { useTranslation } from "../i18n/I18nProvider";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function runCommand<T>(command: string, args?: Record<string, unknown>) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve({} as T);
}

type TranslateFn = (key: string, fallback?: string) => string;

function formatDate(timestamp: number, locale: string): string {
  return new Date(timestamp * 1000).toLocaleString(locale);
}

function formatTimeAgo(timestamp: number, t: TranslateFn, locale: string): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return t("memory.detail.justNow", "刚刚");
  if (seconds < 3600)
    return t("memory.detail.minutesAgo", "{count} 分钟前").replace(
      "{count}",
      String(Math.floor(seconds / 60)),
    );
  if (seconds < 86400)
    return t("memory.detail.hoursAgo", "{count} 小时前").replace(
      "{count}",
      String(Math.floor(seconds / 3600)),
    );
  if (seconds < 604800)
    return t("memory.detail.daysAgo", "{count} 天前").replace(
      "{count}",
      String(Math.floor(seconds / 86400)),
    );
  return new Date(timestamp * 1000).toLocaleDateString(locale);
}

export function MemoryDetail({
  memory,
  onClose,
  onDeleted,
  onUpdated,
}: {
  memory: MemoryItem;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
  onUpdated?: (memory: MemoryItem) => void;
}) {
  const { t, locale } = useTranslation();
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [editTitle, setEditTitle] = useState(memory.title);
  const [editContent, setEditContent] = useState(memory.content);
  const [isEditing, setIsEditing] = useState(false);

  // 记忆内容变化时在渲染期重置编辑态（React 官方的 render 调整模式），
  // 避免在 effect 内同步 setState。
  const [editSource, setEditSource] = useState(() => ({
    id: memory.id,
    title: memory.title,
    content: memory.content,
  }));
  if (
    editSource.id !== memory.id ||
    editSource.title !== memory.title ||
    editSource.content !== memory.content
  ) {
    setEditSource({ id: memory.id, title: memory.title, content: memory.content });
    setEditTitle(memory.title);
    setEditContent(memory.content);
    setIsEditing(false);
  }

  useEffect(() => {
    void runCommand<MemoryRelation[]>("get_memory_relations", {
      memoryId: memory.id,
    }).then(setRelations).catch(() => setRelations([]));
  }, [memory.id]);

  async function handleSave() {
    try {
      const updated = await runCommand<MemoryItem>("update_memory", {
        id: memory.id,
        input: { title: editTitle, content: editContent },
      });
      setEditTitle(updated.title);
      setEditContent(updated.content);
      onUpdated?.(updated);
      setIsEditing(false);
    } catch {
      // ignore
    }
  }

  async function handleDelete() {
    if (!confirm(t("memory.confirm.delete", "确定要删除这条记忆吗？"))) return;
    try {
      await runCommand("delete_memory", { id: memory.id });
      await onDeleted();
      onClose();
    } catch {
      // ignore
    }
  }

  async function handlePin() {
    try {
      await runCommand(memory.isPinned ? "unpin_memory" : "pin_memory", {
        id: memory.id,
      });
      const updated = await runCommand<MemoryItem>("get_memory_detail", {
        id: memory.id,
      });
      onUpdated?.(updated);
      await onDeleted();
    } catch {
      // ignore
    }
  }

  return (
    <div className="memory-detail-overlay" onClick={onClose}>
      <div className="memory-detail" onClick={(e) => e.stopPropagation()}>
        <header className="memory-detail__header">
          <div className="memory-detail__header-left">
            <span
              className={`memory-type-badge memory-type-badge--${memory.memoryType}`}
            >
              {t(`memory.type.${memory.memoryType}`, MEMORY_TYPE_LABELS[memory.memoryType])}
            </span>
            {memory.isPinned && (
              <span className="pin-badge">{t("memory.detail.pinned", "📌 已置顶")}</span>
            )}
          </div>
          <button type="button" className="close-button" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="memory-detail__body">
          {isEditing ? (
            <div className="memory-edit">
              <label>
                <span>{t("memory.detail.titleLabel", "标题")}</span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.currentTarget.value)}
                />
              </label>
              <label>
                <span>{t("memory.detail.contentLabel", "内容")}</span>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.currentTarget.value)}
                  rows={6}
                />
              </label>
              <div className="memory-edit__actions">
                <button type="button" onClick={() => setIsEditing(false)}>
                  {t("memory.detail.cancel", "取消")}
                </button>
                <button type="button" onClick={handleSave}>
                  {t("memory.detail.save", "保存")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="memory-detail__title">{memory.title}</h2>
              <p className="memory-detail__content">{memory.content}</p>
            </>
          )}
        </div>

        <div className="memory-detail__meta">
          <div className="meta-grid">
            <div>
              <span className="meta-label">{t("memory.detail.source", "来源")}</span>
              <span className="meta-value">
                {t(`memory.source.${memory.source}`, MEMORY_SOURCE_LABELS[memory.source])}
              </span>
            </div>
            <div>
              <span className="meta-label">{t("memory.detail.importance", "重要度")}</span>
              <span className="meta-value">{"*".repeat(memory.importance)}</span>
            </div>
            <div>
              <span className="meta-label">{t("memory.detail.confidence", "置信度")}</span>
              <span className="meta-value">
                {(memory.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div>
              <span className="meta-label">{t("memory.detail.createdAt", "创建时间")}</span>
              <span className="meta-value">{formatDate(memory.createdAt, locale)}</span>
            </div>
            <div>
              <span className="meta-label">{t("memory.detail.updatedAt", "更新时间")}</span>
              <span className="meta-value">{formatTimeAgo(memory.updatedAt, t, locale)}</span>
            </div>
            {memory.expiresAt && (
              <div>
                  <span className="meta-label">{t("memory.detail.expiresAt", "过期时间")}</span>
                  <span className="meta-value">{formatDate(memory.expiresAt, locale)}</span>
              </div>
            )}
          </div>

          {memory.tags.length > 0 && (
            <div className="memory-detail__tags">
              {memory.tags.map((tag) => (
                <span key={tag} className="memory-tag">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {relations.length > 0 && (
            <div className="memory-detail__relations">
              <h4>{t("memory.detail.relatedMemories", "相关记忆")}</h4>
              <ul>
                {relations.map((rel, i) => (
                  <li key={i}>
                    <span className="relation-type">
                      {t(
                        `memory.relation.${rel.relationType}`,
                        RELATION_LABELS[rel.relationType] || rel.relationType,
                      )}
                    </span>
                    <code>{rel.fromId === memory.id ? rel.toId : rel.fromId}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="memory-detail__actions">
          <button type="button" onClick={() => setIsEditing(!isEditing)}>
            {isEditing ? t("memory.detail.cancel", "取消") : t("memory.detail.edit", "编辑")}
          </button>
          <button type="button" onClick={handlePin}>
            {memory.isPinned
              ? t("memory.detail.unpin", "取消置顶")
              : t("memory.detail.pin", "置顶")}
          </button>
          <button type="button" className="btn--danger" onClick={handleDelete}>
            {t("memory.detail.delete", "删除")}
          </button>
        </footer>
      </div>
    </div>
  );
}
