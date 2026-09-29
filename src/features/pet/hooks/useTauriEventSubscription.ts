import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../app/appRuntime";

export type EventHandler<T> = (payload: T) => void;

/**
 * Hook for subscribing to a single Tauri event.
 *
 * handler 通过 ref 透传，因此传入内联函数也不会触发重新订阅；
 * 只在 eventName / deps 变化时重订阅。
 *
 * 卸载或依赖变化时无条件注销监听——包括 listen() promise 尚未 resolve
 * 就卸载的情况（resolve 后补注销），不会泄漏监听器。
 *
 * @param eventName - The name of the Tauri event to listen for
 * @param handler - Callback function invoked when the event fires
 * @param deps - Additional dependencies that trigger re-subscription
 */
export function useTauriEventSubscription<T>(
  eventName: string,
  handler: EventHandler<T>,
  deps: readonly unknown[] = []
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!isTauriRuntime) return;

    let active = true;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    const registration = listen<T>(eventName, (event) => {
      if (active) {
        handlerRef.current(event.payload);
      }
    });

    const disposeOnce = (dispose: UnlistenFn) => {
      if (disposed) return;
      disposed = true;
      void dispose();
    };

    void registration.then((dispose) => {
      if (active) {
        unlisten = dispose;
      } else {
        // 注册完成前组件已卸载，在这里补上注销
        disposeOnce(dispose);
      }
    });

    return () => {
      active = false;
      if (unlisten) {
        disposeOnce(unlisten);
        unlisten = null;
      } else {
        void registration.then(disposeOnce);
      }
    };
    // handler 经 ref 透传，不参与依赖；deps 由调用方声明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, ...deps]);
}
