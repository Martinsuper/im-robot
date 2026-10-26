import { expect, it } from "vitest";
import { deviceConversations } from "./deviceConversations";
import type { TaskRecord } from "./TaskHistory";

const device = `passport-${"a".repeat(24)}`;
function record(requestId: string, updatedAt: number, conversationId = device): TaskRecord {
  return { requestId, conversationId, updatedAt, startedAt: updatedAt, status: "completed", steps: [] };
}

it("lists saved conversations after every matching task record has been evicted", () => {
  const history = Array.from({ length: 110 }, (_, index) => ({
    id: `turn-${index}`, conversationId: device, createdAt: index, prompt: `问题 ${index}`,
  }));
  expect(deviceConversations([], history)).toEqual([{ id: device, title: "问题 109" }]);
});

it("deduplicates task metadata and persisted history using the latest title", () => {
  expect(deviceConversations([
    record("older", 1), record("desktop", 4, "desktop-chat"), record("latest", 3),
  ], [
    { id: "older", prompt: "旧问题", createdAt: 1, conversationId: device },
    { id: "latest", prompt: "最新问题", createdAt: 3, conversationId: device },
  ])).toEqual([{ id: device, title: "最新问题" }]);
});

it("keeps failed device conversations accessible without saved answers", () => {
  expect(deviceConversations([{ ...record("failed", 2), status: "failed" }], [])).toEqual([
    { id: device, title: "设备对话" },
  ]);
});

it("does not resurrect completed task metadata after chat history was cleared", () => {
  expect(deviceConversations([record("cleared", 1)], [])).toEqual([]);
});
