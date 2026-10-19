import { invokeCommand, type CommandMap } from "../generated/ipc";
import { listen } from "@tauri-apps/api/event";

type Store = CommandMap["get_pet_state"]["result"];
type Entry = Store["entries"][string];
const keys = [
  "piko-interaction-stats",
  "piko-pet-growth-state",
  "piko-personality-state",
] as const;
const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const origin = typeof crypto !== "undefined" ? crypto.randomUUID() : "preview";
let store: Store | undefined;
let failure: string | undefined;
const queues = new Map<string, Promise<void>>();
const predicted = new Map<string, number>();
const generations = new Map<string, number>();
const subscribers = new Set<() => void>();
let subscription: Promise<unknown> | undefined;
const queuedEvents: Array<{ key: string; entry: Entry; origin: string }> = [];
const notify = () => {
  for (const callback of subscribers) callback();
};
export const persistenceHealth = {
  subscribe(callback: () => void) {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  },
  getSnapshot: () => failure,
};
function report(error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
  notify();
}
function cache(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Native storage is authoritative. */
  }
}
function refreshConsumers(key: string, value: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
}
export async function initializePersistentState(): Promise<void> {
  if (!native || store) return;
  try {
    // Install the observer before loading; events are reconciled by revision after initialization.
    queuedEvents.length = 0;
    subscription ??= listen<{ key: string; entry: Entry; origin: string }>(
      "pet-state-updated",
      ({ payload }) => {
        if (!store) {
          queuedEvents.push(payload);
          return;
        }
        const current = store.entries[payload.key];
        if (current && current.revision > payload.entry.revision) return;
        store.entries[payload.key] =
          payload.origin === origin && current
            ? { revision: payload.entry.revision, value: current.value }
            : payload.entry;
        if (payload.origin !== origin) {
          predicted.set(payload.key, payload.entry.revision);
          cache(payload.key, payload.entry.value);
          refreshConsumers(payload.key, payload.entry.value);
        }
      },
    );
    await subscription;
    let loaded = await invokeCommand("get_pet_state", {});
    if (!loaded || loaded.schemaVersion !== 1)
      throw new Error("宠物存储协议不兼容，请重新安装应用。");
    if (!loaded.initialized) {
      const legacy: Record<string, string> = {};
      for (const key of keys) {
        const value = window.localStorage.getItem(key);
        if (value !== null) legacy[key] = value;
      }
      loaded = await invokeCommand("migrate_pet_state", { legacy });
    }
    store = loaded;
    for (const event of queuedEvents) {
      if ((store.entries[event.key]?.revision ?? 0) < event.entry.revision)
        store.entries[event.key] = event.entry;
    }
    for (const key of keys) {
      cache(key, store.entries[key]?.value ?? null);
      predicted.set(key, store.entries[key]?.revision ?? 0);
    }
    failure = undefined;
    notify();
  } catch (error) {
    report(error);
  }
}
export function readPersistentState(key: string): string | null {
  if (native && store) return store.entries[key]?.value ?? null;
  return typeof window !== "undefined"
    ? window.localStorage.getItem(key)
    : null;
}
export function writePersistentState(key: string, value: string | null): void {
  if (!native) {
    cache(key, value);
    return;
  }
  if (!store || failure) {
    report(failure ?? "宠物数据尚未初始化，已阻止覆盖。");
    return;
  }
  const expectedRevision =
    predicted.get(key) ?? store.entries[key]?.revision ?? 0;
  predicted.set(key, expectedRevision + 1);
  const generation = generations.get(key) ?? 0;
  // Synchronous UI reads see the latest local intent while native writes stay serialized per key.
  store.entries[key] = { revision: store.entries[key]?.revision ?? 0, value };
  cache(key, value);
  const pending = (queues.get(key) ?? Promise.resolve()).then(async () => {
    if ((generations.get(key) ?? 0) !== generation) return;
    try {
      const confirmed = await invokeCommand("save_pet_state", {
        key,
        value,
        expectedRevision,
        origin,
      });
      if (store)
        store.entries[key] = {
          revision: Math.max(
            confirmed.revision,
            store.entries[key]?.revision ?? 0,
          ),
          value: readPersistentState(key),
        };
    } catch (error) {
      generations.set(key, generation + 1);
      try {
        store = await invokeCommand("get_pet_state", {});
        predicted.set(key, store.entries[key]?.revision ?? 0);
        cache(key, store.entries[key]?.value ?? null);
        refreshConsumers(key, store.entries[key]?.value ?? null);
      } catch (reloadError) {
        report(reloadError);
      }
      report(error);
    }
  });
  queues.set(key, pending);
}
export async function flushPersistentState() {
  await Promise.all(queues.values());
  if (native && failure) throw new Error(failure);
}

export async function retryPersistentState() {
  await Promise.all(queues.values());
  store = undefined;
  failure = undefined;
  await initializePersistentState();
}
