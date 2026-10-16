import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalGate, needsApproval } from "./permissions.mjs";

import { fixture, stream } from "./test-support.mjs";

test("real SDK streams responses and resumes persisted context", { timeout: 45000 }, async (t) => {
  const f = await fixture(t, (_req, res) => stream(res, { role: "assistant", content: "任务已完成" }));
  const first = await f.run({ prompt: "记住标识 alpha" });
  assert.equal(first.at(-1).type, "completed", JSON.stringify(first));
  assert.ok(first.some((e) => e.type === "delta" && e.text.includes("任务")));
  const second = await f.run({ prompt: "继续上一次任务" });
  assert.equal(second.at(-1).type, "completed", JSON.stringify(second));
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes("记住标识 alpha"));
  assert.deepEqual(f.requests[0].tools.map((tool) => tool.function.name).sort(),
    [process.platform === "win32" ? "powershell" : "bash", "edit", "read", "write"].sort());
});

for (const allowed of [true, false]) test(`file writes require approval (${allowed ? "allow" : "deny"})`, { timeout: 25000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) stream(res, { role: "assistant", tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "approved" }) } }] }, "tool_calls");
    else stream(res, { role: "assistant", content: allowed ? "已写入" : "已放弃" });
  });
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.equal(events.filter((e) => e.type === "approval").length, 1);
  if (allowed) assert.equal(await readFile(path.join(f.cwd, "result.txt"), "utf8"), "approved");
  else await assert.rejects(readFile(path.join(f.cwd, "result.txt")), { code: "ENOENT" });
});

test("read policy follows symlinks and approval waits cancel", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piko-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"); await mkdir(cwd);
  await writeFile(path.join(cwd, "inside"), "inside");
  await writeFile(path.join(root, "outside"), "outside");
  await symlink(path.join(root, "outside"), path.join(cwd, "link"));
  assert.equal(await needsApproval("read", { path: "inside" }, cwd), false);
  assert.equal(await needsApproval("read", { path: "link" }, cwd), true);
  assert.equal(await needsApproval("bash", { command: "echo hello" }, cwd), true);
  const controller = new AbortController();
  const gate = new ApprovalGate(() => {});
  const wait = gate.request("write", {}, controller.signal);
  controller.abort();
  await assert.rejects(wait, /操作已取消/);
  assert.equal(gate.pending.size, 0);
});

test("cancel interrupts a stalled model response", { timeout: 25000 }, async (t) => {
  let cancel;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": waiting\n\n");
    cancel?.();
  });
  const result = f.run({ onEvent(_event, send) { cancel = () => send({ type: "cancel" }); } });
  const events = await result;
  assert.equal(events.at(-1).type, "cancelled", JSON.stringify(events));
});
