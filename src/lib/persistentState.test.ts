// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("../generated/ipc", () => ({ invokeCommand: invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const key = "piko-pet-growth-state";
let backend: {
  schemaVersion: number;
  initialized: boolean;
  entries: Record<string, { revision: number; value: string | null }>;
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  backend = {
    schemaVersion: 1,
    initialized: true,
    entries: { [key]: { revision: 1, value: null } },
  };
  listen.mockResolvedValue(() => {});
  invoke.mockImplementation(
    async (
      command: string,
      args: {
        key?: string;
        value?: string;
        expectedRevision?: number;
        legacy?: Record<string, string>;
      },
    ) => {
      if (command === "get_pet_state") return structuredClone(backend);
      if (command === "migrate_pet_state") {
        backend.initialized = true;
        for (const [key, value] of Object.entries(args.legacy ?? {}))
          backend.entries[key] = { revision: 1, value };
        return structuredClone(backend);
      }
      if (command === "save_pet_state") {
        const current = backend.entries[args.key!] ?? {
          revision: 0,
          value: null,
        };
        if (current.revision !== args.expectedRevision)
          throw new Error("conflict");
        const entry = {
          revision: current.revision + 1,
          value: args.value ?? null,
        };
        backend.entries[args.key!] = entry;
        return entry;
      }
      throw new Error(command);
    },
  );
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
it("migrates browser data once but does not resurrect cleared native state", async () => {
  backend.initialized = false;
  window.localStorage.setItem(key, '{"xp":10}');
  const state = await import("./persistentState");
  await state.initializePersistentState();
  expect(invoke).toHaveBeenCalledWith("migrate_pet_state", {
    legacy: { [key]: '{"xp":10}' },
  });
  expect(state.readPersistentState(key)).toBe('{"xp":10}');
  backend.entries[key] = { revision: 2, value: null };
  window.localStorage.setItem(key, '{"xp":999}');
  await state.retryPersistentState();
  expect(state.readPersistentState(key)).toBeNull();
  expect(window.localStorage.getItem(key)).toBeNull();
});
it("flushes local edits in order before a snapshot", async () => {
  const state = await import("./persistentState");
  await state.initializePersistentState();
  state.writePersistentState(key, '{"xp":1}');
  state.writePersistentState(key, '{"xp":2}');
  expect(state.readPersistentState(key)).toBe('{"xp":2}');
  await state.flushPersistentState();
  expect(backend.entries[key]).toEqual({ revision: 3, value: '{"xp":2}' });
});
it("a conflict cancels dependent edits and restores the authoritative value", async () => {
  const state = await import("./persistentState");
  await state.initializePersistentState();
  state.writePersistentState(key, '{"xp":1}');
  state.writePersistentState(key, '{"xp":2}');
  backend.entries[key] = { revision: 2, value: '{"xp":50}' };
  await expect(state.flushPersistentState()).rejects.toThrow("conflict");
  expect(
    invoke.mock.calls.filter((c) => c[0] === "save_pet_state"),
  ).toHaveLength(1);
  expect(state.readPersistentState(key)).toBe('{"xp":50}');
  await state.retryPersistentState();
  state.writePersistentState(key, '{"xp":51}');
  await state.flushPersistentState();
  expect(backend.entries[key].value).toBe('{"xp":51}');
});
it("a failed load never overwrites durable native data", async () => {
  invoke.mockRejectedValue(new Error("disk unavailable"));
  const state = await import("./persistentState");
  await state.initializePersistentState();
  state.writePersistentState(key, "{}");
  await expect(state.flushPersistentState()).rejects.toThrow(
    "disk unavailable",
  );
  expect(invoke.mock.calls.some((c) => c[0] === "save_pet_state")).toBe(false);
});

it("shares concurrent initialization and preserves events received while loading", async () => {
  let release!: (value: typeof backend) => void;
  const pending = new Promise<typeof backend>((resolve) => { release = resolve; });
  invoke.mockImplementationOnce(() => pending);
  const state = await import("./persistentState");
  const first = state.initializePersistentState();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const onEvent = listen.mock.calls[0][1];
  onEvent({ payload: { key, entry: { revision: 2, value: '{"xp":20}' }, origin: "other-window" } });
  const second = state.initializePersistentState();
  expect(second).toBe(first);
  release(structuredClone(backend));
  await Promise.all([first, second]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(1);
  expect(state.readPersistentState(key)).toBe('{"xp":20}');
  expect(window.localStorage.getItem(key)).toBe('{"xp":20}');
});

it("retries a failed event registration before loading native state", async () => {
  listen.mockRejectedValueOnce(new Error("event registration failed"));
  const state = await import("./persistentState");
  await state.initializePersistentState();
  expect(state.persistenceHealth.getSnapshot()).toBe("event registration failed");
  expect(invoke).not.toHaveBeenCalled();
  await state.retryPersistentState();
  expect(listen).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledWith("get_pet_state", {});
  expect(state.persistenceHealth.getSnapshot()).toBeUndefined();
  state.writePersistentState(key, '{"xp":3}');
  await state.flushPersistentState();
  expect(backend.entries[key].value).toBe('{"xp":3}');
});
