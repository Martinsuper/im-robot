import { describe, expect, it } from "vitest";
import { MAX_TASK_QUEUE, dropQueuedTask, enqueueQueuedTask, takeQueueHead, type QueuedTask } from "./taskQueues";

describe("本地任务排队", () => {
  const item = (id: string): QueuedTask => ({ id, text: `任务 ${id}` });

  it("按序入队并在满员（5 条）时拒绝", () => {
    let queue: QueuedTask[] = [];
    for (let index = 1; index <= MAX_TASK_QUEUE; index++) {
      const result = enqueueQueuedTask(queue, `任务${index}`, `id-${index}`);
      expect(result.accepted).toBe(true);
      queue = result.queue;
    }
    expect(queue.map((entry) => entry.text)).toEqual(["任务1", "任务2", "任务3", "任务4", "任务5"]);
    const overflow = enqueueQueuedTask(queue, "第六条", "id-6");
    expect(overflow.accepted).toBe(false);
    expect(overflow.queue).toBe(queue);
  });

  it("拒绝空白输入", () => {
    expect(enqueueQueuedTask([], "   ", "id-blank")).toEqual({ queue: [], accepted: false });
  });

  it("入队会裁剪首尾空白", () => {
    const { queue } = enqueueQueuedTask([], "  整理日志  ", "id-trim");
    expect(queue[0].text).toBe("整理日志");
  });

  it("删除只移除指定项", () => {
    const queue = [item("a"), item("b"), item("c")];
    expect(dropQueuedTask(queue, "b").map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(dropQueuedTask(queue, "missing")).toHaveLength(3);
  });

  it("出队返回队首并保留剩余队列", () => {
    const queue = [item("a"), item("b")];
    expect(takeQueueHead(queue)).toEqual({ head: item("a"), queue: [item("b")] });
    expect(takeQueueHead([])).toEqual({ head: null, queue: [] });
  });
});
