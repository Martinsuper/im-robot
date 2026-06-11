import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../app/appRuntime";

export type EventHandler<T> = (payload: T) => void;

export type EventSubscription<T> = {
  eventName: string;
  handler: EventHandler<T>;
};

/**
 * Hook for subscribing to a single Tauri event.
 *
 * Automatically registers the event listener when in Tauri runtime,
 * and cleans up on unmount or when dependencies change.
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
  const mountedRef = useRef(true);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    let cancelled = false;

    void listen<T>(eventName, (event) => {
      if (mountedRef.current) {
        handler(event.payload);
      }
    }).then((unlisten) => {
      if (!cancelled && mountedRef.current) {
        unlistenRef.current = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        const dispose = unlistenRef.current;
        unlistenRef.current = null;
        void dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, handler, ...deps]);
}

/**
 * Hook for subscribing to multiple Tauri events at once.
 *
 * Registers all event listeners when in Tauri runtime,
 * and cleans up all subscriptions on unmount or when dependencies change.
 *
 * @param subscriptions - Array of event subscription configurations
 * @param deps - Additional dependencies that trigger re-subscription
 */
export function useTauriEventSubscriptions(
  subscriptions: EventSubscription<any>[],
  deps: readonly unknown[] = []
): void {
  const mountedRef = useRef(true);
  const unlistenRefs = useRef<Map<string, UnlistenFn>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const pendingUnlistens = new Map<string, Promise<UnlistenFn>>();

    for (const { eventName, handler } of subscriptions) {
      const unlistenPromise = listen(eventName, (event) => {
        if (mountedRef.current) {
          handler(event.payload);
        }
      });

      pendingUnlistens.set(eventName, unlistenPromise);

      unlistenPromise.then((unlisten) => {
        if (mountedRef.current) {
          unlistenRefs.current.set(eventName, unlisten);
        }
      });
    }

    return () => {
      for (const [, unlistenOrPromise] of unlistenRefs.current) {
        void unlistenOrPromise();
      }
      unlistenRefs.current.clear();

      for (const [, unlistenPromise] of pendingUnlistens) {
        void unlistenPromise.then((unlisten) => {
          void unlisten();
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptions, ...deps]);
}
