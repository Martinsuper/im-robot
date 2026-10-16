import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalGate } from "./permissions.mjs";

test("expired approval is removed, reported and cannot be approved later", async () => {
  const events = [];
  const gate = new ApprovalGate((event) => events.push(event), 10);
  await assert.rejects(gate.request("write", { path: "result.txt" }), /确认已超时/);
  assert.equal(gate.pending.size, 0);
  const id = events[0].approvalId;
  assert.deepEqual(events[1], { type: "approval-expired", approvalId: id });
  assert.throws(() => gate.reply(id, true), /已过期/);
});

test("approved and cancelled requests do not emit stale expiry events", async () => {
  const events = [];
  const gate = new ApprovalGate((event) => events.push(event), 10);
  const approved = gate.request("write", {});
  gate.reply(events[0].approvalId, true);
  await approved;
  const cancelled = gate.request("write", {});
  gate.cancel();
  await assert.rejects(cancelled, /操作已取消/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gate.pending.size, 0);
  assert.equal(events.filter((event) => event.type === "approval-expired").length, 0);
});
