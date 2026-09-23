import { createContext, useContext } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** 毫秒；传 0 表示不自动消失。 */
  durationMs?: number;
  action?: ToastAction;
}

/** 省略 message/tone 后的可选参数，供 success/error/info 快捷方法复用。 */
export type ToastExtras = Omit<ToastOptions, "message" | "tone">;

export interface ToastApi {
  show: (options: ToastOptions) => string;
  success: (message: string, extras?: ToastExtras) => string;
  error: (message: string, extras?: ToastExtras) => string;
  info: (message: string, extras?: ToastExtras) => string;
  dismiss: (id: string) => void;
}

/** 各档位默认停留时长：错误留久一点，方便看清原因。 */
export const DEFAULT_TOAST_DURATION: Record<ToastTone, number> = {
  success: 3000,
  error: 6000,
  info: 4000,
};

/**
 * Provider 缺失时的降级实现：只记录到控制台，不抛错。
 * Why：预览窗口与单测可能只挂载局部组件；让 UI 崩掉比丢一条提示更糟。
 */
const FALLBACK_API: ToastApi = {
  show: ({ message, tone = "info" }) => {
    console.warn(`[toast:${tone}] ${message}（ToastProvider 未挂载，未渲染）`);
    return "";
  },
  success: (message) => FALLBACK_API.show({ message, tone: "success" }),
  error: (message) => FALLBACK_API.show({ message, tone: "error" }),
  info: (message) => FALLBACK_API.show({ message, tone: "info" }),
  dismiss: () => {},
};

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK_API;
}
