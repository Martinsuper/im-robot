import { afterEach, expect, it, vi } from "vitest";
import { applyMilestone, CONVERSATION_STORAGE, loadConversation, parseContract, parseReceipt } from "./agentTypes";

afterEach(() => vi.unstubAllGlobals());
function storage(values: Record<string, string>) { vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] || null }); }
it("starts ordinary conversation without requiring a directory or allocating an ID", () => {
  storage({});
  expect(loadConversation()).toEqual({ id: "", cwd: "", importHistory: true, turnIds: [] });
});
it("migrates the previous task session and workspace", () => {
  storage({ "piko-agent-conversation-v1": JSON.stringify({ id: "legacy-session", cwd: "/workspace" }) });
  expect(loadConversation()).toEqual({ id: "legacy-session", cwd: "/workspace", importHistory: true, turnIds: [] });
});
it("keeps the new conversation instead of reverting to a legacy task", () => {
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "new-session", cwd: "", importHistory: false, turnIds: ["a"] }),
    "piko-agent-conversation-v1": JSON.stringify({ id: "legacy", cwd: "/old" }) });
  expect(loadConversation().id).toBe("new-session");
  expect(loadConversation().importHistory).toBe(false);
});

it("restores the conversation knowledge project across reloads", () => {
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "piko-chat", cwd: "", knowledgeScope: "piko", turnIds: ["r1"] }) });
  expect(loadConversation().knowledgeScope).toBe("piko");
  expect(loadConversation().turnIds).toEqual(["r1"]);
});

it("keeps the bound project across reloads and drops malformed project fields", () => {
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "piko-chat", cwd: "/repo", projectId: "p1", projectName: "im-robot", turnIds: [] }) });
  const conversation = loadConversation();
  expect(conversation.projectId).toBe("p1");
  expect(conversation.projectName).toBe("im-robot");
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "piko-chat", cwd: "/repo", projectId: 42, projectName: null, turnIds: [] }) });
  expect(loadConversation().projectId).toBeUndefined();
});

it("coerces the contract payload into an editable object without trusting the wire", () => {
  expect(parseContract(null)).toEqual({ goal: "", milestones: [], verifyCommand: "", timeMinutes: 0, risks: [] });
  const contract = parseContract({
    goal: "修复登录", milestones: [{ id: "m1", title: "定位", acceptance: "复现路径明确" }, { title: "坏条目" }, "not-an-object"],
    verifyCommand: "npm test", timeMinutes: 45, risks: ["改动大", 42],
  });
  expect(contract.milestones).toEqual([
    { id: "m1", title: "定位", acceptance: "复现路径明确" },
    { id: "m2", title: "坏条目", acceptance: "" },
  ]);
  expect(contract.risks).toEqual(["改动大"]);
  expect(parseContract({ milestones: [{ id: "", title: "缺 id" }] }).milestones[0].id).toBe("m1");
});

it("folds milestone events by id and ignores empty ids", () => {
  const started = applyMilestone([], { milestoneId: "m1", status: "started", title: "准备" });
  expect(applyMilestone(started, { milestoneId: "m1", status: "completed" })[0]).toMatchObject({ status: "completed", title: "准备" });
  expect(applyMilestone(started, { milestoneId: "", status: "completed" })).toBe(started);
  expect(applyMilestone([], { milestoneId: "m2", status: "非法" })[0].status).toBe("started");
});

it("flattens the receipt payload and keeps empty collections", () => {
  expect(parseReceipt({})).toEqual({ milestones: [], filesChanged: [], verify: [], notices: [], commits: [], openQuestions: [] });
  const receipt = parseReceipt({
    milestones: [{ id: "m1", status: "completed", title: "准备" }],
    filesChanged: [{ path: "a.ts", added: 2, removed: 1 }, { added: 5 }, "junk"],
    verify: [{ command: "npm test", ok: true, output: "all pass" }, { ok: "yes" }],
    notices: [{ level: "warn", text: "装了依赖" }, { level: "other", text: "说明" }, { level: "warn", text: "" }],
    branch: "piko/task-ab12", commits: ["ab12", 42], openQuestions: ["是否保留兼容层"],
  });
  expect(receipt.filesChanged).toEqual([{ path: "a.ts", added: 2, removed: 1 }]);
  expect(receipt.verify).toEqual([{ command: "npm test", ok: true, output: "all pass" }, { command: "", ok: false, output: undefined }]);
  expect(receipt.notices).toEqual([{ level: "warn", text: "装了依赖" }, { level: "info", text: "说明" }]);
  expect(receipt.commits).toEqual(["ab12"]);
});
