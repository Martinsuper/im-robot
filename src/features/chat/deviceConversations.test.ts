import { expect, it } from "vitest";
import { deviceConversations } from "./deviceConversations";
import type { TaskRecord } from "./TaskHistory";

const device = `passport-${"a".repeat(24)}`;
function record(requestId: string, updatedAt: number, conversationId = device): TaskRecord {
  return { requestId, conversationId, updatedAt, startedAt: updatedAt, status: "completed", steps: [] };
}

it("restores completed device conversations once with the latest saved prompt", () => {
  expect(deviceConversations([
    record("older", 1), record("desktop", 4, "desktop-chat"), record("latest", 3),
  ], [{ id: "older", prompt: "旧问题" }, { id: "latest", prompt: "最新问题" }])).toEqual([
    { id: device, title: "最新问题" },
  ]);
});

it("keeps failed device conversations accessible without saved answers", () => {
  expect(deviceConversations([{ ...record("failed", 2), status: "failed" }], [])).toEqual([
    { id: device, title: "设备对话" },
  ]);
});
