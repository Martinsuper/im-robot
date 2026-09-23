import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  DEFAULT_TOAST_DURATION,
  ToastContext,
  type ToastApi,
  type ToastExtras,
  type ToastOptions,
  type ToastTone,
} from "./toastStore";
import "./feedback.css";

interface ToastRecord {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
  action?: ToastOptions["action"];
}

const TONE_ICON: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.durationMs, toast.id, onDismiss]);

  return (
    <div
      className={`feedback-toast feedback-toast--${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
    >
      <span className="feedback-toast__icon" aria-hidden="true">{TONE_ICON[toast.tone]}</span>
      <p className="feedback-toast__message">{toast.message}</p>
      {toast.action ? (
        <button
          type="button"
          className="feedback-toast__action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="feedback-toast__close"
        aria-label="关闭提示"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * 每个窗口（pet / bubble / panel / capture）是独立 webview，各自挂一个 Provider。
 * 不做跨窗口广播：需要跨窗口同步的状态请走 Tauri 事件 + 单一数据源（见 00 §5.8）。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions) => {
    const tone = options.tone ?? "info";
    counterRef.current += 1;
    const id = `toast-${counterRef.current}`;
    const record: ToastRecord = {
      id,
      message: options.message,
      tone,
      durationMs: options.durationMs ?? DEFAULT_TOAST_DURATION[tone],
      action: options.action,
    };
    // 同一条消息已经在屏幕上就不再叠加，避免连续失败时刷屏。
    setToasts((current) => {
      if (current.some((toast) => toast.message === record.message && toast.tone === record.tone)) {
        return current;
      }
      return [...current, record];
    });
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => {
    const withTone = (tone: ToastTone) => (message: string, extras?: ToastExtras) =>
      show({ ...extras, message, tone });
    return {
      show,
      success: withTone("success"),
      error: withTone("error"),
      info: withTone("info"),
      dismiss,
    };
  }, [dismiss, show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="feedback-toast-viewport" data-testid="toast-viewport">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
