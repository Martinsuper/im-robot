import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/feedback/toastStore";
import { toUserMessage } from "../lib/errors";
import { AutoSaveQueue } from "./autoSaveQueue";

export interface AutoSaveOptions<T> {
  rollback?: () => void;
  onPersisted?: (value: T) => void;
  onSuccess?: (value: T) => void;
  errorFallback?: string;
}
export interface AutoSaveApi {
  schedule: <T>(
    persist: () => Promise<T>,
    options?: AutoSaveOptions<T>,
  ) => void;
  cancel: () => void;
  flush: () => Promise<void>;
}

/** One queue per setting group. Leaving a tab flushes valid edits without updating unmounted UI. */
const groupQueues = new Map<string, AutoSaveQueue>();

export function useAutoSave(delayMs = 400, group?: string): AutoSaveApi {
  const toast = useToast();
  const [queue] = useState(() => {
    if (!group) return new AutoSaveQueue();
    const existing = groupQueues.get(group) ?? new AutoSaveQueue();
    groupQueues.set(group, existing);
    return existing;
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const flush = () => {
      void queue.flush();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [queue]);
  const schedule = useCallback(
    <T>(persist: () => Promise<T>, options: AutoSaveOptions<T> = {}) => {
      queue.schedule(
        persist,
        (value) => {
          if (mounted.current) options.onSuccess?.(value as T);
        },
        (error) => {
          if (mounted.current) options.rollback?.();
          // The app-level toast survives tab navigation and reports flushed-save failures.
          toast.error(
            toUserMessage(
              error,
              options.errorFallback ?? "设置保存失败，请重试。",
            ),
          );
        },
        delayMs,
        (value) => {
          if (mounted.current) options.onPersisted?.(value as T);
        },
      );
    },
    [queue, delayMs, toast],
  );
  const cancel = useCallback(() => queue.cancel(), [queue]);
  const flush = useCallback(() => queue.flush(), [queue]);
  return { schedule, cancel, flush };
}
