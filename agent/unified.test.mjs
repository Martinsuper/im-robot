import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, stream, toolResponse } from "./test-support.mjs";

const say = (res, content = "完成") => stream(res, { role: "assistant", content });
const businessTools = [{ type: "function", function: {
  name: "piko_memo", description: "保存备忘录，由 Piko 展示确认卡片并执行。",
  parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
} }];

test("ordinary chat uses the same agent without selecting a directory", async (t) => {
  const f = await fixture(t, (_req, res) => say(res, "你好"));
  const events = await f.run({ unified: true, workspace: null });
  assert.equal(events.at(-1).type, "completed");
  const names = f.requests[0].tools.map((tool) => tool.function.name);
  assert.ok(names.includes("piko_select_workspace"));
  assert.ok(!names.includes("bash") && !names.includes("read"));
  assert.ok(!events.some((event) => event.type === "app-tool"));
});

test("workspace selection enables real file tools and continues the original turn", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "piko_select_workspace", {});
    else if (requests.length === 2) {
      assert.ok(requests[1].tools.some((tool) => tool.function.name === "read"));
      toolResponse(res, "read", { path: "selected.txt" });
    } else say(res);
  });
  const selected = path.join(f.root, "selected"); await mkdir(selected);
  await writeFile(path.join(selected, "selected.txt"), "SELECTED_WORKSPACE_MARKER");
  const events = await f.run({ unified: true, workspace: null, onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "app-result", callId: event.callId, result: { path: selected } });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes("SELECTED_WORKSPACE_MARKER"));
});

test("business tools work without a directory and await the application result", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "piko_memo", { content: "下周看展" }) : say(res, "已记下"));
  const events = await f.run({ unified: true, workspace: null, businessTools, onEvent(event, send) {
    if (event.type === "app-tool") {
      assert.equal(event.name, "piko_memo");
      send({ type: "app-result", callId: event.callId, result: { message: "用户确认后已保存", id: "memo-1" } });
    }
  } });
  assert.equal(events.at(-1).type, "completed");
  assert.ok(JSON.stringify(f.requests[1].messages).includes("memo-1"));
  assert.equal(events.filter((event) => event.type === "app-tool").length, 1);
});

test("a rejected application operation is returned to the model without bypassing approval", async (t) => {
  const f = await fixture(t, (_req, res, requests) => requests.length === 1
    ? toolResponse(res, "piko_memo", { content: "不保存" }) : say(res, "已取消"));
  const events = await f.run({ unified: true, workspace: null, businessTools, onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "app-result", callId: event.callId, error: "用户拒绝了此操作" });
  } });
  assert.equal(events.at(-1).type, "completed");
  assert.match(JSON.stringify(f.requests[1].messages), /用户拒绝/);
});

test("cancel interrupts a pending business confirmation", async (t) => {
  const f = await fixture(t, (_req, res) => toolResponse(res, "piko_memo", { content: "等待确认" }));
  const events = await f.run({ unified: true, workspace: null, businessTools, onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "cancel" });
  } });
  assert.equal(events.at(-1).type, "cancelled");
});

test("changing selected workspace preserves conversation history", async (t) => {
  const f = await fixture(t, (_req, res) => say(res));
  const first = await f.run({ unified: true, prompt: "记住标识 CHAT_TO_TASK", workspace: f.cwd });
  assert.equal(first.at(-1).type, "completed");
  const other = path.join(f.root, "other"); await mkdir(other);
  const second = await f.run({ unified: true, workspace: other, prompt: "继续" });
  assert.equal(second.at(-1).type, "completed");
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes("CHAT_TO_TASK"));
});

test("a legacy task conversation migrates into unified chat without losing context", async (t) => {
  const f = await fixture(t, (_req, res) => say(res));
  await f.run({ prompt: "保留旧任务上下文 LEGACY_AGENT_CONTEXT" });
  const stable = path.join(f.root, "stable-conversation"); await mkdir(stable);
  const events = await f.run({ unified: true, workingDirectory: stable, workspace: f.cwd });
  assert.equal(events.at(-1).type, "completed");
  assert.match(JSON.stringify(f.requests.at(-1).messages), /LEGACY_AGENT_CONTEXT/);
});

test("recent chat context is imported only on initial session creation", async (t) => {
  const f = await fixture(t, (_req, res) => say(res));
  const history = [{ prompt: "我喜欢摄影", response: "记下了 PHOTO_CONTEXT" }];
  await f.run({ unified: true, workspace: null, history });
  assert.ok(JSON.stringify(f.requests[0].messages).includes("PHOTO_CONTEXT"));
  await f.run({ unified: true, workspace: null, history: [{ prompt: "不应重复导入 WRONG_CONTEXT", response: "" }] });
  assert.ok(!JSON.stringify(f.requests[1].messages).includes("WRONG_CONTEXT"));
});

test("screenshot images stay in the same conversation payload", async (t) => {
  const f = await fixture(t, (_req, res) => say(res));
  const images = [{ type: "image", mimeType: "image/png", data: (await readFile(new URL("../src-tauri/icons/32x32.png", import.meta.url))).toString("base64") }];
  const events = await f.run({ unified: true, workspace: null, images });
  assert.equal(events.at(-1).type, "completed");
  assert.match(JSON.stringify(f.requests[0].messages), /data:image\/png;base64/);
});

test("textual approval after a workspace tool still triggers a real operation", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "piko_select_workspace", {});
    else if (requests.length === 2) say(res, "请批准执行以下命令：pwd");
    else if (requests.length === 3) toolResponse(res, "bash", { command: "pwd" });
    else say(res);
  });
  const events = await f.run({ unified: true, workspace: null, onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "app-result", callId: event.callId, result: { path: f.cwd } });
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
});

test("read-only inspection reads evidence without offering write or shell tools", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "read", { path: "result.txt" });
    else say(res, "已核对文件内容");
  });
  await writeFile(path.join(f.cwd, "result.txt"), "VERIFIED_FILE_CONTENT");
  const events = await f.run({ unified: true, readOnly: true, autoApproveCommands: true });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const names = f.requests[0].tools.map((tool) => tool.function.name).sort();
  assert.deepEqual(names, ["piko_select_workspace", "read"]);
  assert.match(JSON.stringify(f.requests[1].messages), /VERIFIED_FILE_CONTENT/);
});

for (const tool of ["write", process.platform === "win32" ? "powershell" : "bash"]) {
  test(`read-only inspection rejects a model attempt to invoke ${tool}`, async (t) => {
    const f = await fixture(t, (_req, res, requests) => {
      if (requests.length === 1) toolResponse(res, tool, {
        path: "forbidden.txt", content: "MUST_NOT_WRITE",
        command: `"${process.execPath}" -e "require('node:fs').writeFileSync('forbidden.txt','MUST_NOT_WRITE')"`,
      });
      else say(res, "无法在核对模式中修改");
    });
    const events = await f.run({ unified: true, readOnly: true, autoApproveCommands: true });
    assert.ok(["completed", "failed"].includes(events.at(-1).type), JSON.stringify(events));
    await assert.rejects(readFile(path.join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
    assert.ok(!events.some((event) => event.type === "approval"));
    assert.ok(!f.requests[0].tools.some((definition) => definition.function.name === tool));
  });
}

test("selecting workspace during inspection only enables read", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "piko_select_workspace", {});
    else say(res, "目录已选择");
  });
  const events = await f.run({ unified: true, workspace: null, readOnly: true, onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "app-result", callId: event.callId, result: { path: f.cwd } });
  } });
  assert.equal(events.at(-1).type, "completed");
  assert.deepEqual(f.requests[1].tools.map((tool) => tool.function.name).sort(), ["piko_select_workspace", "read"]);
});

test("inspection of an existing writable conversation does not restore old tools", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) say(res, "原会话");
    else if (requests.length === 2) toolResponse(res, "read", { path: "result.txt" });
    else say(res, "核对结束");
  });
  await writeFile(path.join(f.cwd, "result.txt"), "EXISTING_SESSION_EVIDENCE");
  await f.run({ unified: true });
  assert.ok(f.requests[0].tools.some((tool) => tool.function.name === "write"));
  const events = await f.run({ unified: true, readOnly: true, autoApproveCommands: true });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.deepEqual(f.requests[1].tools.map((tool) => tool.function.name).sort(), ["piko_select_workspace", "read"]);
  assert.match(JSON.stringify(f.requests[2].messages), /EXISTING_SESSION_EVIDENCE/);
});

test("steering revokes an old approval and reaches the next model turn", async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) toolResponse(res, "write", { path: "cancelled-write.txt", content: "must not write" });
    else say(res, "按补充要求停止修改");
  });
  const events = await f.run({ unified: true, onEvent(event, send) {
    if (event.type === "approval") send({ type: "steer", text: "不要写文件，改为只读核对 STEER_MARKER" });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(events.some((event) => event.type === "steering-accepted"));
  assert.match(JSON.stringify(f.requests.at(-1).messages), /STEER_MARKER/);
  await assert.rejects(readFile(path.join(f.cwd, "cancelled-write.txt")), { code: "ENOENT" });
});

test("resuming an applied file operation verifies it without executing or approving it again", async (t) => {
  const args = { path: "checkpoint.txt", content: "CHECKPOINT_EFFECT" };
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1 || requests.length === 3) toolResponse(res, "write", args);
    else if (requests.length === 2) { res.writeHead(500); res.end('{"error":{"message":"simulated failure after write"}}'); }
    else say(res, "按检查点核对完成");
  });
  const first = await f.run({ unified: true, requestId: "original-task", onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
  } });
  assert.equal(first.at(-1).type, "failed");
  const resumed = await f.run({ unified: true, requestId: "resume-task", resumeRoot: "original-task" });
  assert.equal(resumed.at(-1).type, "completed", JSON.stringify(resumed));
  assert.ok(!resumed.some((event) => event.type === "approval"));
  assert.ok(resumed.some((event) => event.type === "tool-end" && event.verification?.reused === true));
  assert.ok(!f.requests[2].tools.some((tool) => ["bash", "powershell"].includes(tool.function.name)));
  assert.equal(await readFile(path.join(f.cwd, args.path), "utf8"), args.content);
});
