import { MemoryItem, MEMORY_TYPE_LABELS, MEMORY_SOURCE_LABELS } from "./memoryTypes";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN");
}

function renderImportance(level: number): string {
  return "*".repeat(Math.max(1, Math.min(level, 10)));
}

export function MemoryCard({
  memory,
  onDelete,
  onPin,
  onUnpin,
  onFeedback,
}: {
  memory: MemoryItem;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onFeedback: (id: string, feedbackType: string) => void;
}) {
  return (
    <div className={`memory-card${memory.isPinned ? " memory-card--pinned" : ""}`}>
      <div className="memory-card__header">
        <span className={`memory-type-badge memory-type-badge--${memory.memoryType}`}>
          {memory.isPinned && <span className="pin-icon">📌</span>}
          {MEMORY_TYPE_LABELS[memory.memoryType]}
        </span>
        <span className="memory-card__source">
          {MEMORY_SOURCE_LABELS[memory.source]}
        </span>
      </div>
      <h3 className="memory-card__title">{memory.title}</h3>
      <p className="memory-card__content">
        {memory.content.length > 140
          ? `${memory.content.substring(0, 140)}…`
          : memory.content}
      </p>
      <div className="memory-card__meta">
        <span className="memory-importance" title={`重要度: ${memory.importance}`}>
          {renderImportance(memory.importance)}
        </span>
        <span title={`置信度: ${(memory.confidence * 100).toFixed(0)}%`}>
          {(memory.confidence * 100).toFixed(0)}%
        </span>
        <span title={`近况分: ${(memory.recencyScore * 100).toFixed(0)}%`}>
          {formatTimeAgo(memory.updatedAt)}
        </span>
      </div>
      {memory.tags.length > 0 && (
        <div className="memory-card__tags">
          {memory.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="memory-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="memory-card__actions">
        <div className="memory-feedback">
          <button
            type="button"
            className="memory-feedback-btn memory-feedback-btn--useful"
            title="这条记忆有用"
            onClick={() => onFeedback(memory.id, "useful")}
          >
            👍
          </button>
          <button
            type="button"
            className="memory-feedback-btn memory-feedback-btn--useless"
            title="这条记忆没用"
            onClick={() => onFeedback(memory.id, "useless")}
          >
            👎
          </button>
        </div>
        <div className="memory-pin-actions">
          {memory.isPinned ? (
            <button
              type="button"
              className="memory-action-btn"
              onClick={() => onUnpin(memory.id)}
            >
              取消置顶
            </button>
          ) : (
            <button
              type="button"
              className="memory-action-btn"
              onClick={() => onPin(memory.id)}
            >
              置顶
            </button>
          )}
        </div>
        <button
          type="button"
          className="memory-delete-btn"
          onClick={() => onDelete(memory.id)}
        >
          删除
        </button>
      </div>
    </div>
  );
}
