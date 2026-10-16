import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, symlink, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fixture, stream, toolResponse, within } from "./test-support.mjs";

const shellName = process.platform === "win32" ? "powershell" : "bash";
const quote = (text) => process.platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
const nodeCommand = (code) => `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(code)}`;
const finish = (res) => stream(res, { role: "assistant", content: "功能测试完成" });
function completed(events) { assert.equal(events.at(-1).type, "completed", JSON.stringify(events)); }
async function poll(check, milliseconds = 4000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Condition did not become true before timeout");
}

test("reads real workspace files and returns their content to the model without approval", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "read", { path: "input.txt" }) : finish(res));
  await writeFile(path.join(f.cwd, "input.txt"), "READ_MARKER_真实文件内容");
  const events = await f.run(); completed(events);
  assert.ok(!events.some((event) => event.type === "approval"));
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes("READ_MARKER_真实文件内容"));
  assert.ok(events.some((event) => event.type === "tool-end" && event.output.includes("READ_MARKER")));
});

test("edits existing files only after approval and preserves unrelated content", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "edit", { path: "edit.txt", oldText: "before", newText: "after" }) : finish(res));
  const target = path.join(f.cwd, "edit.txt"); await writeFile(target, "header\nbefore\nfooter\n");
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") {
      assert.equal(readFileSync(target, "utf8"), "header\nbefore\nfooter\n");
      send({ type: "approval", approvalId: event.approvalId, allowed: true });
    }
  } });
  completed(events); assert.equal(await readFile(target, "utf8"), "header\nafter\nfooter\n");
});

for (const allowed of [true, false]) test(`real shell execution ${allowed ? "runs after approval" : "is blocked on denial"}`, async (t) => {
  const command = nodeCommand("require('node:fs').writeFileSync('shell.txt', 'SHELL_MARKER'); console.log(process.cwd())");
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, shellName, { command }) : finish(res));
  const target = path.join(f.cwd, "shell.txt");
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") {
      assert.equal(existsSync(target), false);
      send({ type: "approval", approvalId: event.approvalId, allowed });
    }
  } });
  completed(events);
  if (allowed) {
    assert.equal(await readFile(target, "utf8"), "SHELL_MARKER");
    assert.ok(events.some((event) => event.type === "tool-end" && event.output.includes(f.cwd)));
  } else assert.equal(existsSync(target), false);
});

test("each mutation in a multi-step task gets a separate approval", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "write", { path: "first.txt", content: "first" }, "first");
    else if (requests.length === 2) toolResponse(res, "write", { path: "second.txt", content: "second" }, "second");
    else finish(res);
  });
  const ids = [];
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") {
      ids.push(event.approvalId);
      send({ type: "approval", approvalId: event.approvalId, allowed: ids.length === 1 });
    }
  } });
  completed(events); assert.equal(new Set(ids).size, 2);
  assert.equal(await readFile(path.join(f.cwd, "first.txt"), "utf8"), "first");
  assert.equal(existsSync(path.join(f.cwd, "second.txt")), false);
});

test("rejecting an external symlink read keeps its contents out of the model context", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "read", { path: "external-link.txt" }) : finish(res));
  const outside = path.join(f.root, "outside.txt"); await writeFile(outside, "OUTSIDE_PRIVATE_MARKER");
  await symlink(outside, path.join(f.cwd, "external-link.txt"));
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: false });
  } });
  completed(events); assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.ok(!JSON.stringify(f.requests).includes("OUTSIDE_PRIVATE_MARKER"));
});

test("cancelling while approval is pending does not write a file", async (t) => {
  const f = await fixture(t, (_req, res) => toolResponse(res, "write", { path: "cancelled.txt", content: "must not exist" }));
  const pending = f.run({ onEvent(event, send) { if (event.type === "approval") send({ type: "cancel" }); } });
  const events = await pending;
  assert.equal(events.at(-1).type, "cancelled", JSON.stringify(events));
  assert.equal(existsSync(path.join(f.cwd, "cancelled.txt")), false);
  assert.equal((await within(pending.exited)).code, 0);
});

test("cancelling a running shell stops its child process", async (t) => {
  const command = nodeCommand("require('node:fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)");
  const f = await fixture(t, (_req, res) => toolResponse(res, shellName, { command }));
  const pending = f.run({ onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
  } });
  await poll(() => existsSync(path.join(f.cwd, "child.pid")));
  const pid = Number(await readFile(path.join(f.cwd, "child.pid"), "utf8"));
  // Cleanup remains registered even if the cancellation assertion fails.
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already terminated. */ } });
  pending.send({ type: "cancel" });
  const events = await pending;
  assert.equal(events.at(-1).type, "cancelled", JSON.stringify(events));
  await poll(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  assert.equal((await within(pending.exited)).code, 0);
});

test("an unknown approval ID cannot authorize a waiting operation", async (t) => {
  let actualId;
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "write", { path: "guarded.txt", content: "approved" }) : finish(res));
  const target = path.join(f.cwd, "guarded.txt");
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") { actualId = event.approvalId; send({ type: "approval", approvalId: "unknown-id", allowed: true }); }
    if (event.type === "approval-expired") {
      assert.equal(existsSync(target), false);
      send({ type: "approval", approvalId: actualId, allowed: true });
    }
  } });
  completed(events); assert.ok(events.some((event) => event.type === "approval-expired"));
  assert.equal(await readFile(target, "utf8"), "approved");
});

test("invalid working directory fails before a model request", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  const events = await f.run({ workingDirectory: path.join(f.root, "missing") });
  assert.equal(events.at(-1).type, "failed"); assert.equal(f.requests.length, 0);
});

test("a resumed conversation cannot silently switch to a different directory", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  completed(await f.run());
  const other = path.join(f.root, "other"); await mkdir(other);
  const events = await f.run({ workingDirectory: other });
  assert.equal(events.at(-1).type, "failed"); assert.match(events.at(-1).message, /工作目录不一致/);
  assert.equal(f.requests.length, 1);
});

for (const status of [401, 429, 500]) test(`model HTTP ${status} is reported as failure, not completion`, async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `test-http-${status}`, type: "test_error" } })); });
  const events = await f.run();
  assert.equal(events.at(-1).type, "failed", JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("API key is sent as authentication but not persisted or emitted", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  const pending = f.run(); const events = await pending; completed(events);
  assert.equal(f.httpRequests[0].headers.authorization, "Bearer mock-key");
  assert.ok(!JSON.stringify(events).includes("mock-key"));
  for (const file of await readdir(path.join(f.root, "data"), { recursive: true })) {
    if (file.endsWith(".json") || file.endsWith(".jsonl")) assert.ok(!(await readFile(path.join(f.root, "data", file), "utf8")).includes("mock-key"), file);
  }
  const exit = await within(pending.exited);
  assert.equal(exit.code, 0, JSON.stringify(exit));
});

test("Anthropic adapter streams a real messages protocol response", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "mock", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANTHROPIC_MARKER" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const events = await f.run({ provider: "anthropic" }); completed(events);
  assert.ok(events.some((event) => event.type === "delta" && event.text.includes("ANTHROPIC_MARKER")));
  assert.match(f.httpRequests[0].url, /\/messages/);
  assert.equal(f.httpRequests[0].headers["x-api-key"], "mock-key");
});

test("Gemini adapter streams a real generateContent protocol response", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "GEMINI_MARKER" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }, modelVersion: "mock" })}\n\n`);
  });
  const events = await f.run({ provider: "gemini" }); completed(events);
  assert.ok(events.some((event) => event.type === "delta" && event.text.includes("GEMINI_MARKER")));
  assert.match(f.httpRequests[0].url, /streamGenerateContent/);
  assert.ok(f.httpRequests[0].headers["x-goog-api-key"] === "mock-key" || f.httpRequests[0].url.includes("key=mock-key"));
});

test("corrupt session metadata fails without silently discarding context", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  completed(await f.run());
  await writeFile(path.join(f.root, "data", "sessions", "test-session", "current.json"), "invalid-json");
  const events = await f.run();
  assert.equal(events.at(-1).type, "failed");
  assert.equal(f.requests.length, 1);
});

test("session metadata cannot redirect loading outside its conversation directory", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  completed(await f.run());
  const target = path.join(f.root, "outside-session.jsonl"); await writeFile(target, "outside");
  await writeFile(path.join(f.root, "data", "sessions", "test-session", "current.json"), JSON.stringify({ cwd: f.cwd, sessionFile: target }));
  const events = await f.run();
  assert.equal(events.at(-1).type, "failed"); assert.match(events.at(-1).message, /无效的会话文件/);
  assert.equal(f.requests.length, 1);
});

test("missing session history reports an error instead of silently starting over", async (t) => {
  const f = await fixture(t, (_req, res) => finish(res));
  completed(await f.run());
  const metadata = JSON.parse(await readFile(path.join(f.root, "data", "sessions", "test-session", "current.json"), "utf8"));
  await unlink(metadata.sessionFile);
  const events = await f.run({ prompt: "继续之前的任务" });
  assert.equal(events.at(-1).type, "failed", JSON.stringify(events));
  assert.match(events.at(-1).message, /历史文件缺失/);
  assert.equal(f.requests.length, 1);
});

test("text-only approval is corrected into a real tool call and confirmation event", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) stream(res, { role: "assistant", content: "我需要先查看目录内容。请批准执行以下命令：\n```bash\nls -la\n```" });
    else if (requests.length === 2) toolResponse(res, shellName, { command: nodeCommand("console.log('ACTUAL_TOOL_MARKER')") });
    else finish(res);
  });
  const events = await f.run({ onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
  } });
  completed(events);
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.ok(events.some((event) => event.type === "tool-end" && event.output.includes("ACTUAL_TOOL_MARKER")));
  assert.match(JSON.stringify(f.requests[1].messages), /此消息不代表用户批准/);
});

test("a model that keeps asking for textual approval cannot report completion", async (t) => {
  const f = await fixture(t, (_req, res) => stream(res, { role: "assistant", content: "请批准执行以下命令：ls -la" }));
  const events = await f.run();
  assert.equal(events.at(-1).type, "failed");
  assert.match(events.at(-1).message, /没有发起工具调用/);
  assert.equal(f.requests.length, 2);
  assert.ok(!events.some((event) => event.type === "completed" || event.type === "approval"));
});

test("a retry that simply claims success without tools is still a failure", async (t) => {
  const f = await fixture(t, (_req, res, requests) => stream(res, { role: "assistant", content: requests.length === 1 ? "请批准运行命令" : "已完成检查。" }));
  const events = await f.run();
  assert.equal(events.at(-1).type, "failed");
  assert.equal(f.requests.length, 2);
});

for (const autoApproveCommands of [true, false]) {
  test(`command approval setting ${autoApproveCommands} controls real execution`, async (t) => {
    const command = nodeCommand("require('node:fs').writeFileSync('auto-command.txt', 'AUTO_COMMAND_MARKER')");
    const f = await fixture(t, (_req, res, requests) => requests.length === 1
      ? toolResponse(res, shellName, { command }) : finish(res));
    const events = await f.run({ autoApproveCommands, onEvent(event, send) {
      if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
    }});
    completed(events);
    assert.equal(events.filter((e) => e.type === "approval").length, autoApproveCommands ? 0 : 1);
    assert.equal(await readFile(path.join(f.cwd, "auto-command.txt"), "utf8"), "AUTO_COMMAND_MARKER");
  });
}

test("command auto approval still requires file mutation approval", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "write", { path: "denied.txt", content: "denied" }) : finish(res));
  const events = await f.run({ autoApproveCommands: true, onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: false });
  }});
  completed(events);
  assert.equal(events.filter((e) => e.type === "approval").length, 1);
  assert.equal(existsSync(path.join(f.cwd, "denied.txt")), false);
});
