import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MemoryItem,
  MemoryRelation,
  RELATION_LABELS,
  MEMORY_TYPE_LABELS,
  MEMORY_SOURCE_LABELS,
} from "./memoryTypes";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function runCommand<T>(command: string, args?: Record<string, unknown>) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve({} as T);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("zh-CN");
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN");
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
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [editTitle, setEditTitle] = useState(memory.title);
  const [editContent, setEditContent] = useState(memory.content);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    setEditTitle(memory.title);
    setEditContent(memory.content);
    setIsEditing(false);
    void runCommand<MemoryRelation[]>("get_memory_relations", {
      memoryId: memory.id,
    }).then(setRelations).catch(() => setRelations([]));
  }, [memory.id, memory.title, memory.content]);

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
    if (!confirm("确定要删除这条记忆吗？")) return;
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
              {MEMORY_TYPE_LABELS[memory.memoryType]}
            </span>
            {memory.isPinned && <span className="pin-badge">📌 已置顶</span>}
          </div>
          <button type="button" className="close-button" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="memory-detail__body">
          {isEditing ? (
            <div className="memory-edit">
              <label>
                <span>标题</span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.currentTarget.value)}
                />
              </label>
              <label>
                <span>内容</span>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.currentTarget.value)}
                  rows={6}
                />
              </label>
              <div className="memory-edit__actions">
                <button type="button" onClick={() => setIsEditing(false)}>
                  取消
                </button>
                <button type="button" onClick={handleSave}>
                  保存
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
              <span className="meta-label">来源</span>
              <span className="meta-value">
                {MEMORY_SOURCE_LABELS[memory.source]}
              </span>
            </div>
            <div>
              <span className="meta-label">重要度</span>
              <span className="meta-value">{"*".repeat(memory.importance)}</span>
            </div>
            <div>
              <span className="meta-label">置信度</span>
              <span className="meta-value">
                {(memory.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div>
              <span className="meta-label">创建时间</span>
              <span className="meta-value">{formatDate(memory.createdAt)}</span>
            </div>
            <div>
              <span className="meta-label">更新时间</span>
              <span className="meta-value">{formatTimeAgo(memory.updatedAt)}</span>
            </div>
            {memory.expiresAt && (
              <div>
                <span className="meta-label">过期时间</span>
                <span className="meta-value">{formatDate(memory.expiresAt)}</span>
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
              <h4>相关记忆</h4>
              <ul>
                {relations.map((rel, i) => (
                  <li key={i}>
                    <span className="relation-type">
                      {RELATION_LABELS[rel.relationType] || rel.relationType}
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
            {isEditing ? "取消" : "编辑"}
          </button>
          <button type="button" onClick={handlePin}>
            {memory.isPinned ? "取消置顶" : "置顶"}
          </button>
          <button type="button" className="btn--danger" onClick={handleDelete}>
            删除
          </button>
        </footer>
      </div>
    </div>
  );
}
