import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, eventEnvelope, PROTOCOL_VERSION } from "./protocol.mjs";

test("reject incompatible versions, malformed commands and stale task commands", () => {
  for (const value of [null, [], {}, { type: "cancel", protocolVersion: 2 },
    { type: "approval", approvalId: "a", allowed: "false" },
    { type: "steer", text: " " }, { type: "app-result" },
    { type: "cancel", requestId: "old" }, { type: "start" }]) {
    assert.throws(() => parseCommand(JSON.stringify(value), "current"));
  }
  assert.throws(() => parseCommand("{", "current"));
});

test("accept legacy clients and versioned controls without coercing approvals", () => {
  assert.deepEqual(parseCommand('{"type":"cancel"}'), { type: "cancel" });
  const command = { type: "approval", approvalId: "a", allowed: false, requestId: "current", protocolVersion: PROTOCOL_VERSION };
  assert.deepEqual(parseCommand(JSON.stringify(command), "current"), command);
});

test("stamp events with authoritative protocol and task identity", () => {
  assert.deepEqual(eventEnvelope({ type: "completed", requestId: "wrong", protocolVersion: 9 }, "current"),
    { type: "completed", protocolVersion: 1, requestId: "current" });
});

test("real sidecar preserves version and identity throughout a task", { timeout: 25000 }, async (t) => {
  const { fixture, stream } = await import("./test-support.mjs");
  const f = await fixture(t, (_request, response) => stream(response, { role: "assistant", content: "hello" }));
  const events = await f.run({ prompt: "hello", requestId: "protocol-task" });
  assert.equal(events.at(-1).type, "completed");
  assert.ok(events.length > 1);
  for (const event of events) {
    assert.equal(event.protocolVersion, PROTOCOL_VERSION);
    assert.equal(event.requestId, "protocol-task");
  }
});
