import { randomUUID } from "node:crypto";

// Piko remains the authority for application tools and their confirmation UI.
export class AppToolBridge {
  pending = new Map();
  constructor(emit) { this.emit = emit; }
  request(name, args, signal) {
    if (signal?.aborted) return Promise.reject(new Error("操作已取消"));
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (result, error) => {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(callId);
        error ? reject(new Error(error)) : resolve(result);
      };
      const abort = () => finish(undefined, "操作已取消");
      this.pending.set(callId, finish);
      signal?.addEventListener("abort", abort, { once: true });
      this.emit({ type: "app-tool", callId, name, arguments: args });
    });
  }
  reply(callId, result, error) {
    const finish = this.pending.get(callId);
    if (!finish) return; // Late replies after cancellation cannot resume a task.
    finish(result, error);
  }
  cancel() { for (const finish of [...this.pending.values()]) finish(undefined, "操作已取消"); }
}

export function applicationTools(definitions, bridge) {
  return definitions.map(({ function: definition }) => ({
    name: definition.name, label: definition.name, description: definition.description,
    parameters: definition.parameters, executionMode: "sequential",
    async execute(_id, args, signal) {
      const result = await bridge.request(definition.name, args, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, details: { verification: result?.verification } };
    },
  }));
}
