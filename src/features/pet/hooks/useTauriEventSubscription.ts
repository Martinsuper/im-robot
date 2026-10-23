import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../app/appRuntime";
import { disposeAsyncSubscriptions } from "../../../lib/eventSubscription";

export type EventHandler<T> = (payload: T) => void;
export type EventSubscription<T> = { eventName: string; handler: EventHandler<T> };

export function useTauriEventSubscription<T>(eventName: string, handler: EventHandler<T>, deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!isTauriRuntime) return;
    let active = true;
    const dispose = disposeAsyncSubscriptions([
      listen<T>(eventName, (event) => { if (active) handler(event.payload); }),
    ]);
    return () => { active = false; dispose(); };
    // Callers explicitly supply additional values used by the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, handler, ...deps]);
}

export function useTauriEventSubscriptions<T>(subscriptions: EventSubscription<T>[], deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!isTauriRuntime) return;
    let active = true;
    const dispose = disposeAsyncSubscriptions(subscriptions.map(({ eventName, handler }) =>
      listen<T>(eventName, (event) => { if (active) handler(event.payload); }),
    ));
    return () => { active = false; dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptions, ...deps]);
}
