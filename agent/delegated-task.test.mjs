import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCommand, eventEnvelope, PROTOCOL_VERSION } from "./protocol.mjs";
import { isDangerousCommand, resolveWithinWorkspace, taskNeedsApproval } from "./permissions.mjs";
import { codingCompactionSettings } from "./sdk-adapter.mjs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fixture, stream, toolResponse } from "./test-support.mjs";

const shellName = process.platform === "win32" ? "powershell" : "bash";
const AUTO_POLICY = { workspaceFiles: "auto", shell: "confirm", outsideWorkspace: "confirm" };

const contractText = (overrides = {}) => JSON.stringify({
  goal: "为 greet 模块补齐实现与测试",
  milestones: [
    { id: "m1", title: "实现 greet 函数", acceptance: "greet.js 导出 greet" },
    { id: "m2", title: "补充冒烟验证", acceptance: "验证脚本通过" },
  ],
  verifyCommand: "", timeMinutes: 45, risks: [],
  ...overrides,
});

const approveContract = (overrides = {}) => (event, send) => {
  if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId,
    contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off",
    policy: AUTO_POLICY, ...overrides });
};

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitInit = (cwd) => {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "piko@example.com"]);
  git(cwd, ["config", "user.name", "Piko"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(cwd, "README.md"), "base\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
};

test("protocol v2 validates and stamps the delegated-task wire objects", () => {
  assert.throws(() => parseCommand(JSON.stringify({ type: "contract" })));
  const command = { type: "contract", requestId: "r1", contractId: "c1", approved: true,
    contract: { goal: "g" }, gitMode: "branch", policy: { workspaceFiles: "auto" }, protocolVersion: PROTOCOL_VERSION };
  assert.deepEqual(parseCommand(JSON.stringify(command), "r1"), command);
  assert.deepEqual(parseCommand(JSON.stringify({ type: "steer", text: "x", mode: "guidance" }), "r1"),
    { type: "steer", text: "x", mode: "guidance" });
  // doc 18 §9：steer 的可选 reason 字段原样透传，缺失时不合成
  assert.deepEqual(parseCommand(JSON.stringify({ type: "steer", text: "收尾", mode: "guidance", reason: "budget" }), "r1"),
    { type: "steer", text: "收尾", mode: "guidance", reason: "budget" });
  assert.deepEqual(eventEnvelope({ type: "milestone", milestoneId: "m1", status: "started", title: "t" }, "r1"),
    { type: "milestone", milestoneId: "m1", status: "started", title: "t", protocolVersion: PROTOCOL_VERSION, requestId: "r1" });
  assert.equal(eventEnvelope({ type: "receipt", status: "suspended", receipt: {} }, "r1").protocolVersion, PROTOCOL_VERSION);
  assert.throws(() => eventEnvelope({ type: "notice", text: "缺 level" }, "r1"));
});

test("task policy helpers classify commands and workspace containment", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piko-taskpolicy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"); await mkdir(cwd);
  await writeFile(path.join(cwd, "inside.txt"), "inside");
  assert.equal(await resolveWithinWorkspace(cwd, "new-file.txt"), true); // 尚未创建也算区内
  assert.equal(await resolveWithinWorkspace(cwd, "../outside.txt"), false);
  assert.equal(await resolveWithinWorkspace(cwd, path.join(root, "escape.txt")), false);
  assert.equal(isDangerousCommand("rm -rf ./build"), true);
  assert.equal(isDangerousCommand("git push origin main"), true);
  assert.equal(isDangerousCommand("sudo rm index.js"), true);
  assert.equal(isDangerousCommand("echo hi > /etc/passwd"), true);
  assert.equal(isDangerousCommand("echo hello"), false);
  assert.equal(isDangerousCommand("npm test"), false);
  assert.equal(await taskNeedsApproval("bash", { command: "echo hi" }, cwd, { shell: "auto" }), false);
  assert.equal(await taskNeedsApproval("bash", { command: "rm -rf x" }, cwd, { shell: "auto" }), true);
  assert.equal(await taskNeedsApproval("bash", { command: "echo hi" }, cwd, { shell: "confirm" }), true);
  assert.equal(await taskNeedsApproval("write", { path: "inside.txt" }, cwd, { workspaceFiles: "auto" }), false);
  assert.equal(await taskNeedsApproval("write", { path: "inside.txt" }, cwd, { workspaceFiles: "confirm" }), true);
  assert.equal(await taskNeedsApproval("write", { path: "../outside.txt" }, cwd, { workspaceFiles: "auto" }), true);
  assert.equal(await taskNeedsApproval("read", { path: "inside.txt" }, cwd, {}), false);
});

test("delegated coding task proposes a contract, runs milestones and reports a receipt", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return stream(res, { role: "assistant", tool_calls: [
      { index: 0, id: "call-log", type: "function", function: { name: "write", arguments: JSON.stringify({ path: ".piko/task-logtask1.md", content: "# 已完成\n- 契约确认\n# 下一步\n- 实现 greet\n# 疑问\n无" }) } },
      { index: 1, id: "call-greet", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "greet.js", content: "export const greet = (name) => `hi ${name}`;" }) } },
    ] }, "tool_calls");
    if (n === 3) return stream(res, { role: "assistant", content: "里程碑 m1 已完成。" });
    if (n === 4) return toolResponse(res, "write", { path: "greet.test.js", content: "import { greet } from './greet.js';" });
    return stream(res, { role: "assistant", content: "里程碑 m2 已完成。" });
  });
  await mkdir(path.join(f.cwd, ".piko"), { recursive: true });
  const events = await f.run({ requestId: "logtask1", taskKind: "coding", onEvent: approveContract() });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const proposed = events.find((event) => event.type === "contract-proposed");
  assert.ok(proposed && typeof proposed.contractId === "string" && proposed.contractId.length > 0, JSON.stringify(events));
  assert.equal(proposed.contract.goal, "为 greet 模块补齐实现与测试");
  assert.deepEqual(events.filter((event) => event.type === "milestone").map((event) => `${event.milestoneId}:${event.status}`),
    ["m1:started", "m1:completed", "m2:started", "m2:completed"]);
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "completed");
  assert.match(receipt.summary, /里程碑完成 2\/2/);
  assert.equal(receipt.receipt.milestones.length, 2);
  assert.ok(receipt.receipt.milestones.every((milestone) => milestone.status === "completed"));
  assert.deepEqual(receipt.receipt.filesChanged, []);
  assert.deepEqual(receipt.receipt.verify, []);
  assert.ok(Array.isArray(receipt.receipt.notices) && Array.isArray(receipt.receipt.commits));
  assert.equal(receipt.receipt.branch, "");
  assert.ok(receipt.receipt.openQuestions.some((question) => question.includes("gitMode=off")));
  assert.equal(receipt.receipt.milestones[0].id, "m1");
  // policy auto：工作区内写入（含 .piko 任务日志）全程免审批
  assert.ok(!events.some((event) => event.type === "approval"), JSON.stringify(events));
  assert.equal(await readFile(path.join(f.cwd, ".piko/task-logtask1.md"), "utf8").then((v) => v.includes("契约确认")), true);
  // 每个模型回合后都有 usage 事件
  assert.ok(events.some((event) => event.type === "usage" && Number.isFinite(event.inputTokens)
    && Number.isFinite(event.outputTokens) && Number.isFinite(event.elapsedMs)), JSON.stringify(events.filter((e) => e.type === "usage")));
  // 任务日志摘要在下一里程碑边界回注
  assert.match(JSON.stringify(f.requests.at(-1).messages), /已完成/);
  // 提示词分域：无聊天助手人格段，有 coding 纪律与任务日志位置
  const system = JSON.stringify(f.requests[0].messages.filter((message) => message.role === "system"));
  assert.doesNotMatch(system, /统一聊天助手/);
  assert.match(system, /委托式任务执行代理/);
  assert.match(system, /task-logtask1\.md/);
  assert.ok(f.requests[0].tools.some((tool) => tool.function.name === shellName));
  assert.equal(await readFile(path.join(f.cwd, "greet.js"), "utf8"), "export const greet = (name) => `hi ${name}`;");
});

test("rejecting the contract cancels the task before any milestone", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) return stream(res, { role: "assistant", content: contractText() });
    return stream(res, { role: "assistant", content: "不应执行" });
  });
  const events = await f.run({ requestId: "reject1", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: false });
  } });
  assert.equal(events.at(-1).type, "cancelled", JSON.stringify(events));
  assert.equal(events.at(-1).message, "用户未确认任务契约");
  assert.ok(!events.some((event) => event.type === "milestone"), JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "receipt"), JSON.stringify(events));
});

test("the contract ruling object overrides the generated draft", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "草稿里程碑", acceptance: "" }] }) });
    return stream(res, { role: "assistant", content: "编辑后的里程碑执行完成。" });
  });
  const events = await f.run({ requestId: "editc1", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true,
      contract: { goal: "编辑后的目标 EDITED_GOAL", milestones: [{ id: "e1", title: "用户编辑的里程碑 EDITED_MILESTONE", acceptance: "" }], verifyCommand: "" },
      gitMode: "off" });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.deepEqual(events.filter((event) => event.type === "milestone").map((event) => `${event.milestoneId}:${event.status}`),
    ["e1:started", "e1:completed"]);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /EDITED_MILESTONE/);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /EDITED_GOAL/);
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.receipt.milestones[0].id, "e1");
});

test("unparseable contract output is retried once before failing the task", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) return stream(res, { role: "assistant", content: "这个任务需要更多上下文，暂时给不出计划。" });
    if (requests.length === 2) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "唯一里程碑", acceptance: "" }] }) });
    return stream(res, { role: "assistant", content: "唯一里程碑执行完成。" });
  });
  const events = await f.run({ requestId: "retryc1", taskKind: "coding", onEvent: approveContract() });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(f.requests.length >= 3, JSON.stringify(f.requests.length));
  assert.match(JSON.stringify(f.requests[1].messages), /无法解析/);
});

test("failed verification injects the report for self-diagnosis, then suspends with a receipt", { timeout: 90000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "跑验收", acceptance: "check 通过" }], verifyCommand: "node check.js" }) });
    if (n === 2) return stream(res, { role: "assistant", content: "第一次尝试完成。" });
    if (n === 3) return stream(res, { role: "assistant", content: "自诊断后再次尝试。" });
    return stream(res, { role: "assistant", content: "仍未修复。" });
  });
  await writeFile(path.join(f.cwd, "check.js"), 'console.error("VERIFY_FAILED_MARKER"); process.exit(3);');
  const events = await f.run({ requestId: "verifyfail", taskKind: "coding", onEvent: approveContract() });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const failed = events.filter((event) => event.type === "milestone" && event.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].milestoneId, "m1");
  // 两次自诊断重试都注入了验收报告（退出码 + 尾部输出）
  assert.match(JSON.stringify(f.requests[2].messages), /VERIFY_FAILED_MARKER/);
  assert.match(JSON.stringify(f.requests[3].messages), /VERIFY_FAILED_MARKER/);
  assert.match(JSON.stringify(f.requests[2].messages), /退出码/);
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "suspended");
  assert.equal(receipt.receipt.verify.length, 3);
  assert.ok(receipt.receipt.verify.every((entry) => entry.ok === false && entry.command === "node check.js"));
  assert.equal(receipt.receipt.milestones[0].status, "failed");
  assert.ok(receipt.receipt.openQuestions.some((question) => question.includes("m1")));
});

test("contract onFailure=skip marks a failed milestone as skipped and still completes", { timeout: 90000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "必失败", acceptance: "" }], verifyCommand: "node check.js", onFailure: "skip" }) });
    if (n === 2) return stream(res, { role: "assistant", content: "尝试一。" });
    if (n === 3) return stream(res, { role: "assistant", content: "尝试二。" });
    return stream(res, { role: "assistant", content: "尝试三。" });
  });
  await writeFile(path.join(f.cwd, "check.js"), "process.exit(1);");
  const events = await f.run({ requestId: "skipfail", taskKind: "coding", onEvent: approveContract() });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.deepEqual(events.filter((event) => event.type === "milestone").map((event) => `${event.milestoneId}:${event.status}`),
    ["m1:started", "m1:failed", "m1:skipped"]);
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.receipt.milestones[0].status, "skipped");
});

test("guidance neither revokes approvals nor lands mid-milestone; it reaches the next boundary", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return toolResponse(res, shellName, { command: "echo GUIDANCE_SHELL_OK" });
    if (n === 3) return stream(res, { role: "assistant", content: "m1 完成。" });
    return stream(res, { role: "assistant", content: "m2 完成。" });
  });
  const events = await f.run({ requestId: "guide1", taskKind: "coding", policy: AUTO_POLICY, onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off" });
    if (event.type === "approval") {
      // guidance 不吊销授权：待审批原样有效；也不关闭自动批准
      send({ type: "steer", text: "GUIDANCE_KEEP_MARK", mode: "guidance" });
      send({ type: "approval", approvalId: event.approvalId, allowed: true });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(events.some((event) => event.type === "steering-accepted" && event.text === "GUIDANCE_KEEP_MARK"));
  assert.ok(!events.some((event) => event.type === "approval-expired"), JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /GUIDANCE_KEEP_MARK/);
});

test("budget exhaustion guidance suspends gracefully at the next milestone boundary", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return stream(res, { role: "assistant", content: "m1 完成。" });
    return stream(res, { role: "assistant", content: "不应执行 m2。" });
  });
  const events = await f.run({ requestId: "budget1", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off", policy: AUTO_POLICY });
    // 宿主在里程碑执行期间注入收尾指令（与真实时机一致），下一里程碑边界生效
    if (event.type === "milestone" && event.status === "started") {
      send({ type: "steer", text: "任务预算即将耗尽，请收尾：提交当前进度并输出总结", mode: "guidance" });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "milestone" && event.milestoneId === "m2" && event.status === "started"), JSON.stringify(events));
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "suspended");
  assert.ok(receipt.receipt.milestones.some((milestone) => milestone.id === "m2" && milestone.status === "pending"));
  assert.ok(receipt.receipt.openQuestions.some((question) => question.includes("预算")));
});

test("steer reason=budget authoritatively suspends even without the legacy phrasing", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return stream(res, { role: "assistant", content: "m1 完成。" });
    return stream(res, { role: "assistant", content: "不应执行 m2。" });
  });
  const events = await f.run({ requestId: "budget2", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off", policy: AUTO_POLICY });
    // 文本刻意不含“预算即将耗尽/请收尾”：收尾只能由 reason==="budget" 权威触发（doc 18 §9）
    if (event.type === "milestone" && event.status === "started") {
      send({ type: "steer", text: "预算信号：停止新的工作，整理当前进度", mode: "guidance", reason: "budget" });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "milestone" && event.milestoneId === "m2" && event.status === "started"), JSON.stringify(events));
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "suspended");
  assert.ok(receipt.receipt.milestones.some((milestone) => milestone.id === "m2" && milestone.status === "pending"));
  assert.ok(receipt.receipt.openQuestions.some((question) => question.includes("预算")));
  assert.ok(events.some((event) => event.type === "steering-accepted" && event.text === "预算信号：停止新的工作，整理当前进度"), JSON.stringify(events));
});

test("plain guidance without budget reason or legacy phrasing keeps the task running", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return stream(res, { role: "assistant", content: "m1 完成。" });
    return stream(res, { role: "assistant", content: "m2 完成。" });
  });
  const events = await f.run({ requestId: "guideplain", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off", policy: AUTO_POLICY });
    if (event.type === "milestone" && event.status === "started" && event.milestoneId === "m1") {
      send({ type: "steer", text: "补充指示：输出风格保持简洁", mode: "guidance" });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  // 无预算信号：所有里程碑照常执行，不挂起
  assert.deepEqual(events.filter((event) => event.type === "milestone").map((event) => `${event.milestoneId}:${event.status}`),
    ["m1:started", "m1:completed", "m2:started", "m2:completed"]);
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.status, "completed");
  // guidance 照常在下一里程碑边界注入
  assert.match(JSON.stringify(f.requests.at(-1).messages), /补充指示/);
});

test("coding compaction tuning resolves through the SDK and companion keeps defaults", () => {
  // keepRecentTokens 取 40000 与 contextWindow 一半的较小者
  assert.deepEqual(codingCompactionSettings(200000), { enabled: true, keepRecentTokens: 40000 });
  assert.deepEqual(codingCompactionSettings(64000), { enabled: true, keepRecentTokens: 32000 });
  assert.deepEqual(codingCompactionSettings(32000), { enabled: true, keepRecentTokens: 16000 });
  // coding：SDK SettingsManager.inMemory 接受这些键，reserveTokens 维持内置默认 16384
  const coding = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
    defaultThinkingLevel: "medium", compaction: codingCompactionSettings(200000) });
  assert.deepEqual(coding.getCompactionSettings(), { enabled: true, reserveTokens: 16384, keepRecentTokens: 40000 });
  // companion：不传 compaction，SDK 默认原样（与改造前一致）
  const companion = SettingsManager.inMemory({ retry: { enabled: false }, defaultThinkingLevel: "off" });
  assert.deepEqual(companion.getCompactionSettings(), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
});

test("policy workspaceFiles=auto waives in-workspace approvals and keeps write checkpoints", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "写文件", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "auto.txt", content: "AUTO_WRITTEN" });
    return stream(res, { role: "assistant", content: "m1 完成。" });
  });
  const events = await f.run({ requestId: "policyauto", taskKind: "coding", onEvent: approveContract() });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(!events.some((event) => event.type === "approval"), JSON.stringify(events));
  assert.equal(await readFile(path.join(f.cwd, "auto.txt"), "utf8"), "AUTO_WRITTEN");
  // FileOperations 写前检查点 + 读回验收保持不变
  assert.ok(events.some((event) => event.type === "tool-end" && event.tool === "write" && event.verification?.state === "verified"), JSON.stringify(events));
});

test("policy auto still confirms writes outside the workspace", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "外写", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "../escape.txt", content: "ESCAPED" });
    return stream(res, { role: "assistant", content: "处理完成。" });
  });
  const events = await f.run({ requestId: "escape1", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off", policy: AUTO_POLICY });
    if (event.type === "approval") {
      assert.equal(event.tool, "write");
      send({ type: "approval", approvalId: event.approvalId, allowed: true });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.equal(await readFile(path.join(f.root, "escape.txt"), "utf8"), "ESCAPED");
});

test("policy shell=auto runs safe commands but still confirms dangerous ones", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText() });
    if (n === 2) return toolResponse(res, shellName, { command: "echo SAFE_ECHO_MARK" });
    if (n === 3) return stream(res, { role: "assistant", content: "m1 安全命令已执行。" });
    if (n === 4) return toolResponse(res, shellName, { command: "rm -rf ./leftover" });
    return stream(res, { role: "assistant", content: "m2 危险命令待确认。" });
  });
  const events = await f.run({ requestId: "shellauto", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: true, contract: event.contract, gitMode: "off",
      policy: { workspaceFiles: "confirm", shell: "auto", outsideWorkspace: "confirm" } });
    if (event.type === "approval") {
      assert.match(event.arguments.command, /rm\s+-rf/);
      send({ type: "approval", approvalId: event.approvalId, allowed: true });
    }
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  // echo 免审批执行，rm -rf 仍走审批
  assert.ok(events.some((event) => event.type === "tool-end" && event.tool === shellName && !event.isError
    && (event.output || "").includes("SAFE_ECHO_MARK")), JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.match(events.find((event) => event.type === "approval").arguments.command, /rm\s+-rf/);
});

test("companion tasks ignore policy fields and keep per-operation approvals", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    if (requests.length === 1) return toolResponse(res, "write", { path: "companion.txt", content: "COMPANION_MARK" });
    return stream(res, { role: "assistant", content: "已写入。" });
  });
  const events = await f.run({ taskKind: "companion", policy: { workspaceFiles: "auto", shell: "auto", outsideWorkspace: "auto" }, onEvent(event, send) {
    if (event.type === "approval") send({ type: "approval", approvalId: event.approvalId, allowed: true });
  } });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  assert.ok(!events.some((event) => ["contract-proposed", "milestone", "receipt", "notice"].includes(event.type)), JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "approval").length, 1); // policy 被忽略：仍逐操作审批
  assert.equal(await readFile(path.join(f.cwd, "companion.txt"), "utf8"), "COMPANION_MARK");
  assert.ok(events.some((event) => event.type === "usage" && Number.isFinite(event.inputTokens)), JSON.stringify(events));
});

test("git safety net creates a task branch and commits only touched files", { timeout: 90000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "实现 greet", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "greet.js", content: "export const greet = () => 'hi';\n" });
    return stream(res, { role: "assistant", content: "m1 完成。" });
  });
  gitInit(f.cwd);
  const events = await f.run({ requestId: "abcd1234", taskKind: "coding", onEvent: approveContract({ gitMode: "branch" }) });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.receipt.branch, "piko/task-abcd");
  assert.equal(receipt.receipt.commits.length, 1);
  assert.ok(receipt.receipt.filesChanged.some((entry) => entry.path === "greet.js" && entry.added >= 1), JSON.stringify(receipt.receipt.filesChanged));
  assert.ok(events.some((event) => event.type === "notice" && event.text.includes("piko/task-abcd")));
  assert.equal(git(f.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "piko/task-abcd");
  assert.match(git(f.cwd, ["log", "-1", "--format=%s"]), /^piko\(task\): m1 实现 greet/);
  assert.ok(events.some((event) => event.type === "notice" && event.text.includes("greet.js"))); // 黄旗：计划外新增文件
});

test("files-only mode commits only task-touched files on the current branch", { timeout: 90000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "实现 greet", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "greet.js", content: "export const greet = () => 'hi';\n" });
    return stream(res, { role: "assistant", content: "m1 完成。" });
  });
  gitInit(f.cwd);
  await writeFile(path.join(f.cwd, "dirty.txt"), "USER_DIRTY_CHANGE");
  const events = await f.run({ requestId: "fileonly1", taskKind: "coding", onEvent: approveContract({ gitMode: "files-only" }) });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.receipt.branch, "");
  assert.equal(receipt.receipt.commits.length, 1);
  const head = git(f.cwd, ["show", "--name-only", "--format=", "HEAD"]);
  assert.ok(head.includes("greet.js"), head);
  assert.ok(!head.includes("dirty.txt"), head);
  assert.ok(!git(f.cwd, ["branch", "--list"]).includes("piko/task-"));
});

test("non-git workspace degrades gracefully and is noted in the receipt", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "写文件", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "plain.txt", content: "PLAIN" });
    return stream(res, { role: "assistant", content: "m1 完成。" });
  });
  const events = await f.run({ requestId: "nogit1", taskKind: "coding", onEvent: approveContract({ gitMode: "branch" }) });
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const receipt = events.find((event) => event.type === "receipt");
  assert.equal(receipt.receipt.branch, "");
  assert.deepEqual(receipt.receipt.commits, []);
  assert.deepEqual(receipt.receipt.filesChanged, []);
  assert.ok(events.some((event) => event.type === "notice" && event.text.includes("不是 git 仓库")));
  assert.ok(receipt.receipt.openQuestions.some((question) => question.includes("git")));
});

test("resuming a coding task restores shell tools for the orchestrator", { timeout: 90000 }, async (t) => {
  let failing = true;
  const f = await fixture(t, (_req, res, requests) => {
    const n = requests.length;
    if (n === 1) return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "写入", acceptance: "" }] }) });
    if (n === 2) return toolResponse(res, "write", { path: "resume.txt", content: "RESUME_CODING_MARK" });
    if (failing) { res.writeHead(500); res.end(JSON.stringify({ error: { message: "simulated failure after write" } })); return; }
    return stream(res, { role: "assistant", content: contractText({ milestones: [{ id: "m1", title: "续跑里程碑", acceptance: "" }] }) });
  });
  const first = await f.run({ requestId: "resumecode", taskKind: "coding", onEvent: approveContract() });
  assert.equal(first.at(-1).type, "failed", JSON.stringify(first));
  assert.equal(await readFile(path.join(f.cwd, "resume.txt"), "utf8"), "RESUME_CODING_MARK");
  failing = false;
  const offset = f.requests.length;
  const resumed = await f.run({ requestId: "resume2", resumeRoot: "resumecode", taskKind: "coding", onEvent(event, send) {
    if (event.type === "contract-proposed") send({ type: "contract", requestId: event.requestId, contractId: event.contractId, approved: false });
  } });
  assert.equal(resumed.at(-1).type, "cancelled", JSON.stringify(resumed));
  // 续跑恢复 shell 工具（companion 续跑仍禁用，见 unified.test.mjs）
  assert.ok(f.requests[offset].tools.some((tool) => tool.function.name === shellName),
    JSON.stringify(f.requests[offset].tools?.map((tool) => tool.function.name)));
});
