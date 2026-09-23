import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/feedback/toastStore";
import { toUserMessage } from "../lib/errors";

export interface AutoSaveOptions<T> {
  /** 失败时回滚到「服务端已确认的值」。 */
  rollback?: () => void;
  /** 成功时用服务端返回值纠正本地状态（服务端可能做了裁剪或归一化）。 */
  onSuccess?: (value: T) => void;
  /** 失败文案兜底。 */
  errorFallback?: string;
}

export interface AutoSaveApi {
  /**
   * 排队一次保存。同一时刻只有最后一次会真正执行（debounce）。
   *
   * 并发正确性：每次 schedule 递增序号，只有序号仍是最新的那次才允许写回结果，
   * 避免「先发后至」的响应把用户的新改动覆盖掉。
   */
  schedule: <T>(persist: () => Promise<T>, options?: AutoSaveOptions<T>) => void;
  /** 丢弃尚未执行的保存（例如用户在输入过程中把值改成了非法值）。 */
  cancel: () => void;
}

/**
 * 设置项即时保存。对应设计原则 00 §5.3「即时保存原则」：
 * 改完即持久化，不出现「改完忘了保存」；失败要有可见反馈且不能留下半截状态。
 */
export function useAutoSave(delayMs = 400): AutoSaveApi {
  const toast = useToast();
  const timerRef = useRef<number | undefined>(undefined);
  const seqRef = useRef(0);

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  // 组件卸载时不要留下悬挂的定时器
  useEffect(() => cancel, [cancel]);

  const schedule = useCallback(
    <T,>(persist: () => Promise<T>, options: AutoSaveOptions<T> = {}) => {
      cancel();
      const seq = ++seqRef.current;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        void (async () => {
          try {
            const value = await persist();
            if (seq !== seqRef.current) return;
            options.onSuccess?.(value);
          } catch (error) {
            if (seq !== seqRef.current) return;
            options.rollback?.();
            toast.error(toUserMessage(error, options.errorFallback ?? "设置保存失败，请重试。"));
          }
        })();
      }, delayMs);
    },
    [cancel, delayMs, toast],
  );

  return { schedule, cancel };
}
