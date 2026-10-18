import type { AgentEvent, AgentTaskSnapshot } from "./agentTypes";

type RecoveryOptions = {
  subscribe: (onEvent: (event: AgentEvent) => void) => Promise<() => void>;
  getSnapshot: () => Promise<AgentTaskSnapshot | null | undefined>;
  restore: (snapshot: AgentTaskSnapshot) => void;
  onEvent: (event: AgentEvent) => void;
};

/** Subscribe before reading; replay only events newer than the authoritative snapshot. */
export function connectAgentTask(options: RecoveryOptions) {
  let disposed = false;
  let buffering = true;
  let buffered: AgentEvent[] = [];
  const sequences = new Map<string, number>();
  function deliver(event: AgentEvent) {
    if (disposed) return;
    if (event.eventSequence !== undefined) {
      if (event.eventSequence <= (sequences.get(event.requestId) ?? 0)) return;
      sequences.set(event.requestId, event.eventSequence);
    }
    options.onEvent(event);
  }
  const subscription = options.subscribe((event) => {
    if (disposed) return;
    if (buffering) buffered.push(event); else deliver(event);
  });
  const ready = subscription.then(async () => {
    if (disposed) return;
    const snapshot = await options.getSnapshot();
    if (disposed) return;
    if (snapshot) {
      sequences.set(snapshot.requestId, snapshot.eventSequence);
      options.restore(snapshot);
    }
    buffering = false;
    for (const event of buffered) deliver(event);
    buffered = [];
  }).catch((error) => {
    buffering = false;
    buffered = [];
    throw error;
  });
  return { ready, dispose: () => {
    disposed = true;
    buffered = [];
    void subscription.then((unsubscribe) => unsubscribe(), () => {});
  } };
}
