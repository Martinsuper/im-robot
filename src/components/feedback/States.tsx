import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import "./feedback.css";

export interface EmptyStateProps {
  /** 建议用 lucide 图标，尺寸 20~24。 */
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** 统一空状态。禁止再用裸 `<p className="empty-state">暂无数据</p>`。 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="feedback-empty">
      {icon ? <span className="feedback-empty__icon" aria-hidden="true">{icon}</span> : null}
      <p className="feedback-empty__title">{title}</p>
      {description ? <p className="feedback-empty__description">{description}</p> : null}
      {action ? <div className="feedback-empty__action">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** 必须已经过 `toUserMessage` 处理，不要直传原始异常。 */
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  retryLabel?: string;
}

/** 统一错误状态。内联在内容区时用它；瞬时反馈用 `useToast().error()`。 */
export function ErrorState({ message, onRetry, onDismiss, retryLabel = "重试" }: ErrorStateProps) {
  return (
    <div className="feedback-error" role="alert">
      <AlertTriangle className="feedback-error__icon" size={16} aria-hidden="true" />
      <div className="feedback-error__body">
        <p className="feedback-error__message">{message}</p>
        {onRetry || onDismiss ? (
          <div className="feedback-error__actions">
            {onRetry ? (
              <button type="button" className="feedback-error__retry" onClick={onRetry}>
                {retryLabel}
              </button>
            ) : null}
            {onDismiss ? (
              <button type="button" className="feedback-error__dismiss" onClick={onDismiss}>
                关闭
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
