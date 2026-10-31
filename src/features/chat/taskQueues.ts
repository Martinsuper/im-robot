/**
 * 本地任务排队（doc/design/18 §9，纯前端行为）：
 * agentBusy 期间的新任务输入按会话串行排队（内存态），终态后自动发送队首。
 */
export const MAX_TASK_QUEUE = 5;

export type QueuedTask = { id: string; text: string };

export type EnqueueResult = { queue: QueuedTask[]; accepted: boolean };

/** 入队；空文本或满员（MAX_TASK_QUEUE）时拒绝，由调用方提示，绝不静默丢弃。 */
export function enqueueQueuedTask(queue: QueuedTask[], text: string, id: string): EnqueueResult {
  if (!text.trim() || queue.length >= MAX_TASK_QUEUE) return { queue, accepted: false };
  return { queue: [...queue, { id, text: text.trim() }], accepted: true };
}

export function dropQueuedTask(queue: QueuedTask[], id: string): QueuedTask[] {
  return queue.filter((item) => item.id !== id);
}

export function takeQueueHead(queue: QueuedTask[]): { head: QueuedTask | null; queue: QueuedTask[] } {
  const [head = null, ...rest] = queue;
  return { head, queue: rest };
}
