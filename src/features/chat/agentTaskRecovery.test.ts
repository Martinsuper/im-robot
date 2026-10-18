import { describe, expect, it, vi } from "vitest";
import { connectAgentTask } from "./agentTaskRecovery";
import type { AgentEvent, AgentTaskSnapshot } from "./agentTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const snapshot: AgentTaskSnapshot = {
  requestId: "task", conversationId: "conversation", cwd: null,
  prompt: "hello", response: "a", eventSequence: 2, events: [],
};

describe("subscribe / snapshot / live-event handover", () => {
  it("subscribes first, drops overlapping events, and delivers each new delta once", async () => {
    const read = deferred<AgentTaskSnapshot>();
    let emit!: (event: AgentEvent) => void;
    const received: string[] = [];
    const restore = vi.fn(() => received.push("snapshot:a"));
    const connection = connectAgentTask({
      subscribe: async (handler) => { emit = handler; return vi.fn<() => void>(); },
      getSnapshot: () => read.promise, restore,
      onEvent: (event) => received.push(`delta:${event.text}`),
    });
    emit({ type: "delta", requestId: "task", eventSequence: 2, text: "a" });
    emit({ type: "delta", requestId: "task", eventSequence: 3, text: "b" });
    expect(received).toEqual([]);
    read.resolve(snapshot);
    await connection.ready;
    emit({ type: "delta", requestId: "task", eventSequence: 3, text: "b" });
    emit({ type: "delta", requestId: "task", eventSequence: 4, text: "c" });
    expect(received).toEqual(["snapshot:a", "delta:b", "delta:c"]);
    expect(restore).toHaveBeenCalledOnce();
    connection.dispose();
  });

  it("delivers a different task that starts while an older snapshot is being read", async () => {
    let emit!: (event: AgentEvent) => void;
    const onEvent = vi.fn<() => void>();
    const connection = connectAgentTask({
      subscribe: async (handler) => { emit = handler; return vi.fn<() => void>(); },
      getSnapshot: async () => snapshot, restore: vi.fn<() => void>(), onEvent,
    });
    const next: AgentEvent = { type: "started", requestId: "next", eventSequence: 1, conversationId: "conversation", prompt: "next" };
    emit(next);
    await connection.ready;
    expect(onEvent).toHaveBeenCalledWith(next);
    connection.dispose();
  });

  it("unsubscribes when disposed before subscription resolves, without hydrating an unmounted view", async () => {
    const subscription = deferred<() => void>();
    const unsubscribe = vi.fn<() => void>();
    const getSnapshot = vi.fn(async () => snapshot);
    const restore = vi.fn<() => void>();
    const connection = connectAgentTask({ subscribe: () => subscription.promise, getSnapshot, restore, onEvent: vi.fn<() => void>() });
    connection.dispose();
    subscription.resolve(unsubscribe);
    await connection.ready;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not hydrate or deliver queued events when disposed during a snapshot read", async () => {
    const read = deferred<AgentTaskSnapshot>();
    let emit!: (event: AgentEvent) => void;
    const restore = vi.fn<() => void>();
    const onEvent = vi.fn<() => void>();
    const connection = connectAgentTask({ subscribe: async (handler) => { emit = handler; return vi.fn<() => void>(); },
      getSnapshot: () => read.promise, restore, onEvent });
    await Promise.resolve();
    emit({ type: "completed", requestId: "task", eventSequence: 3 });
    connection.dispose();
    read.resolve(snapshot);
    await connection.ready;
    expect(restore).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("propagates recovery failures instead of pretending to have an empty idle task", async () => {
    const restore = vi.fn<() => void>();
    const connection = connectAgentTask({ subscribe: async () => vi.fn<() => void>(),
      getSnapshot: async () => { throw new Error("read failed"); }, restore, onEvent: vi.fn<() => void>() });
    await expect(connection.ready).rejects.toThrow("read failed");
    expect(restore).not.toHaveBeenCalled();
    connection.dispose();
  });
});
