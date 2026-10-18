import { expect, test, type Page } from "@playwright/test";

type Call = { command: string; args: Record<string, unknown> };
type Bridge = {
  calls: Call[];
  directory: string | null;
  startError: string;
  emit: (payload: Record<string, unknown>) => void;
};

async function installAgentBackend(page: Page, taskRecords: unknown[] = []) {
  await page.addInitScript((savedTasks) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { topic: string; handler: number }>();
    let sequence = 0;
    const state = {
      calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
      directory: "/tmp/piko-agent-ui-test" as string | null,
      startError: "",
      savePath: null as string | null,
      saveError: "",
      attachmentPreview: { displayName: "ui-test.md", byteSize: 12, charCount: 12, preview: "isolated test" },
      history: [] as Array<{ id: string; prompt: string; response: string; createdAt: number }>,
      output: {} as Record<string, string>,
      emit(payload: Record<string, unknown>) {
        const id = payload.requestId as string;
        if (payload.type === "delta") state.output[id] = (state.output[id] || "") + String(payload.text || "");
        if (payload.type === "completed") {
          const call = state.calls.find((call) => call.command === "agent_start" && (call.args.input as Record<string, unknown>).requestId === id);
          if (call) state.history.push({ id, prompt: String((call.args.input as Record<string, unknown>).prompt), response: state.output[id] || "", createdAt: Math.floor(Date.now() / 1000) });
        }
        for (const [id, listener] of listeners) {
          if (listener.topic === "agent-event") callbacks.get(listener.handler)?.({ event: "agent-event", id, payload });
        }
      },
    };
    const win = window as unknown as Record<string, unknown>;
    win.__agentTest = state;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
    win.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "bubble" }, currentWebview: { label: "bubble" } },
      transformCallback(callback: (event: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: Record<string, unknown> = {}) {
        state.calls.push({ command, args: structuredClone(args) });
        if (command === "plugin:event|listen") {
          const id = ++sequence;
          listeners.set(id, { topic: args.event as string, handler: args.handler as number });
          return id;
        }
        if (command === "plugin:dialog|open") return state.directory;
        if (command === "plugin:dialog|save") return state.savePath;
        if (command === "prepare_text_attachment") return structuredClone(state.attachmentPreview);
        if (command === "save_generated_text" && state.saveError && args.overwrite !== true) throw state.saveError;
        if (command === "agent_start" && state.startError) throw state.startError;
        if (command === "get_settings") return {
          companionName: "Piko", theme: "sage", language: "zh-CN", hasApiKey: true, htmlPreviewEnabled: false,
          ai: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "ui-test", temperature: 0.7, timeoutSeconds: 30 },
        };
        if (command === "agent_list_tasks") return savedTasks;
        if (command === "get_bubble_chat_history") return structuredClone(state.history);
        return null;
      },
    };
  }, taskRecords);
  await page.goto("/?view=bubble");
}

async function bridge(page: Page, action: "directory" | "error", value: string | null) {
  await page.evaluate(({ action, value }) => {
    const state = (window as unknown as { __agentTest: Bridge }).__agentTest;
    if (action === "directory") state.directory = value;
    else state.startError = value || "";
  }, { action, value });
}
async function calls(page: Page, command: string) {
  return page.evaluate((command) => (window as unknown as { __agentTest: Bridge }).__agentTest.calls.filter((call) => call.command === command), command);
}
async function start(page: Page, prompt = "检查项目并整理说明") {
  await page.getByLabel("发送给 Piko 的问题").fill(prompt);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect.poll(() => calls(page, "agent_start")).not.toHaveLength(0);
  return (await calls(page, "agent_start")).at(-1)!.args.input as { requestId: string; conversationId: string; cwd?: string; unified: boolean; importHistory: boolean; prompt: string; verificationOf?: string };
}
async function emit(page: Page, requestId: string, event: Record<string, unknown>) {
  await page.evaluate((payload) => (window as unknown as { __agentTest: Bridge }).__agentTest.emit(payload), { ...event, requestId });
}

test.use({ viewport: { width: 480, height: 420 } });

test("reload restores interruption records without starting or approving a task", async ({ page }) => {
  await installAgentBackend(page, [{
    requestId: "interrupted-request", conversationId: "previous-chat", status: "interrupted", startedAt: 1, updatedAt: 2,
    steps: [{ id: "read", tool: "read", status: "completed" }, { id: "write", tool: "write", status: "unknown" }],
  }]);
  await expect(page.getByText("write · 结果未知")).toBeVisible();
  await page.reload();
  await expect(page.getByText("任务记录 · 有中断任务待核对")).toBeVisible();
  await expect(page.getByText("read · 工具已返回")).toBeVisible();
  await expect(page.getByText("write · 结果未知")).toBeVisible();
  expect(await calls(page, "agent_start")).toHaveLength(0);
  expect(await calls(page, "agent_approve")).toHaveLength(0);
  expect(await calls(page, "agent_confirm_action")).toHaveLength(0);
});

test("inspection remains read-only through follow-ups until explicitly ended", async ({ page }) => {
  await installAgentBackend(page, [{
    requestId: "interrupted-request", conversationId: "previous-chat", status: "interrupted", startedAt: 1, updatedAt: 2,
    steps: [{ id: "write", tool: "write", status: "unknown" }],
  }]);
  await page.getByRole("button", { name: "只读核对结果" }).click();
  await expect.poll(() => calls(page, "agent_start")).toHaveLength(1);
  const first = (await calls(page, "agent_start"))[0].args.input as { requestId: string; verificationOf: string };
  expect(first.verificationOf).toBe("interrupted-request");
  await expect(page.getByRole("button", { name: "结束核对" })).toBeDisabled();
  await emit(page, first.requestId, { type: "completed" });
  const followup = await start(page, "请检查我选择的目录");
  expect(followup.verificationOf).toBe(first.verificationOf);
  await emit(page, followup.requestId, { type: "completed" });
  await page.getByRole("button", { name: "结束核对" }).click();
  const normal = await start(page, "现在处理新的任务");
  expect(normal.verificationOf).toBeUndefined();
});

test("failure action restores a draft without replaying the original request", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page, "创建一个提醒");
  await emit(page, first.requestId, { type: "failed", message: "请核对实际结果" });
  await page.getByRole("button", { name: "编辑后再发送" }).click();
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveValue("创建一个提醒");
  expect(await calls(page, "agent_start")).toHaveLength(1);
});

test("tool outcome shows file target and evidence and can inspect a completed task", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page, "生成报告");
  await emit(page, first.requestId, { type: "tool-start", toolCallId: "write-1", tool: "write", arguments: { path: "report.md", content: "report" } });
  await emit(page, first.requestId, { type: "tool-end", toolCallId: "write-1", tool: "write", isError: false, output: "Wrote report.md" });
  await emit(page, first.requestId, { type: "completed" });
  const result = page.getByRole("region", { name: "本轮执行结果" });
  await expect(result.getByText("1 项工具返回成功 · 0 项报告失败 · 0 项结果未知")).toBeVisible();
  await expect(result.getByText("report.md", { exact: true })).toBeVisible();
  await result.getByText("查看工具证据").click();
  await expect(result.getByText("Wrote report.md")).toBeVisible();
  await result.getByRole("button", { name: "只读核对本轮结果" }).click();
  await expect.poll(() => calls(page, "agent_start")).toHaveLength(2);
  const followup = (await calls(page, "agent_start"))[1].args.input as { verificationOf?: string };
  expect(followup.verificationOf).toBe(first.requestId);
});

test("reported completion cannot hide failed or unfinished tools", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page, "整理文件");
  await emit(page, first.requestId, { type: "tool-start", toolCallId: "write-1", tool: "write", arguments: { path: "missing.txt" } });
  await emit(page, first.requestId, { type: "tool-end", toolCallId: "write-1", tool: "write", isError: true, output: "Permission denied" });
  await emit(page, first.requestId, { type: "tool-start", toolCallId: "shell-1", tool: "bash", arguments: {} });
  await emit(page, first.requestId, { type: "completed" });
  const result = page.getByRole("region", { name: "本轮执行结果" });
  await expect(result.getByText("执行已结束，有步骤需要核对")).toBeVisible();
  await expect(result.getByText("0 项工具返回成功 · 1 项报告失败 · 1 项结果未知")).toBeVisible();
  await expect(result.getByText("文件操作目标")).toHaveCount(0);
  const next = await start(page, "你好");
  await emit(page, next.requestId, { type: "completed" });
  await expect(page.getByRole("region", { name: "本轮执行结果" })).toHaveCount(0);
});

test("running task accepts a supplement without starting another engine", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page, "整理文件");
  await page.getByLabel("发送给 Piko 的问题").fill("不要删除文件");
  await page.getByRole("button", { name: "补充要求", exact: true }).click();
  await expect.poll(() => calls(page, "agent_steer")).toHaveLength(1);
  expect(await calls(page, "agent_start")).toHaveLength(1);
  // Draft stays until the running engine acknowledges receipt.
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveValue("不要删除文件");
  await emit(page, first.requestId, { type:"steering-accepted", text:"不要删除文件" });
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveValue("");
});

test("safe resume reconnects the original conversation and keeps a resume root", async ({ page }) => {
  await installAgentBackend(page, [{ requestId:"interrupted", conversationId:"original-conversation", status:"interrupted", startedAt:1, updatedAt:2, steps:[{id:"w",tool:"write",status:"unknown"}] }]);
  await page.getByRole("button", { name:"安全续跑", exact:true }).click();
  await expect.poll(() => calls(page, "agent_start")).toHaveLength(1);
  const input = (await calls(page, "agent_start"))[0].args.input as {resumeOf:string;conversationId:string;verificationOf?:string};
  expect(input.resumeOf).toBe("interrupted"); expect(input.conversationId).toBe("original-conversation"); expect(input.verificationOf).toBeUndefined();
  await expect(page.getByRole("button", { name:"结束续跑" })).toBeDisabled();
});

test("expired approval disappears and cannot execute from a stale card", async ({ page }) => {
  await installAgentBackend(page);
  const input = await start(page);
  await emit(page, input.requestId, { type: "approval", approvalId: "expired", tool: "write", arguments: { path: "result.txt" } });
  await expect(page.getByRole("button", { name: "允许此次操作" })).toBeVisible();
  await emit(page, input.requestId, { type: "approval-expired", approvalId: "expired" });
  await expect(page.getByRole("button", { name: "允许此次操作" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "操作确认已超时，该操作未获批准" })).toBeVisible();
  expect(await calls(page, "agent_approve")).toHaveLength(0);
});

test("task failure clears confirmations and allows an immediate follow-up", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page);
  await emit(page, first.requestId, { type: "approval", approvalId: "pending", tool: "write", arguments: {} });
  await emit(page, first.requestId, { type: "failed", message: "任务等待过久，已停止。此前可能已有部分操作完成，请检查结果后再决定是否重试。" });
  await expect(page.getByRole("button", { name: "允许此次操作" })).toHaveCount(0);
  const next = await start(page, "先检查之前的结果");
  expect(next.requestId).not.toBe(first.requestId);
  expect(next.conversationId).toBe(first.conversationId);
});

test("one composer handles ordinary chat without a workspace or mode switch", async ({ page }) => {
  await installAgentBackend(page);
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(page.getByText("让 Piko 执行任务")).toHaveCount(0);
  const input = await start(page, "你好");
  expect(input.unified).toBe(true); expect(input.cwd).toBeUndefined();
  await emit(page, input.requestId, { type: "delta", text: "你好，有什么想聊的？" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByText("你好，有什么想聊的？", { exact: true })).toBeVisible();
  expect(await calls(page, "chat_start")).toHaveLength(0);
});

test("browser preview keeps one composer and disables native directory selection", async ({ page }) => {
  await page.goto("/?view=bubble");
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^📁/ })).toBeDisabled();
  await page.getByLabel("发送给 Piko 的问题").fill("你好");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("这是浏览器预览回复：你好", { exact: true })).toBeVisible();
});

test("directory cancellation preserves text and ordinary sending remains available", async ({ page }) => {
  await installAgentBackend(page); await bridge(page, "directory", null);
  await page.getByLabel("发送给 Piko 的问题").fill("保留这段输入");
  await page.getByRole("button", { name: /^📁/ }).click();
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveValue("保留这段输入");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
});

test("workspace selection is requested in the reply and resumes the same turn", async ({ page }) => {
  await installAgentBackend(page);
  const input = await start(page, "检查本地文件");
  await emit(page, input.requestId, { type: "workspace-required" });
  await expect(page.getByRole("region", { name: "选择工作目录", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择文件夹并继续" }).click();
  expect((await calls(page, "agent_select_workspace"))[0].args).toEqual({ requestId: input.requestId, path: "/tmp/piko-agent-ui-test" });
  expect(await calls(page, "agent_start")).toHaveLength(1);
  await emit(page, input.requestId, { type: "delta", text: "已检查该文件夹。" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByRole("button", { name: /^📁/ })).toHaveAttribute("title", "/tmp/piko-agent-ui-test");
});

test("cancel directory access without cancelling ordinary conversation", async ({ page }) => {
  await installAgentBackend(page);
  const input = await start(page);
  await emit(page, input.requestId, { type: "workspace-required" });
  await page.getByRole("button", { name: "取消此次操作" }).click();
  expect((await calls(page, "agent_select_workspace"))[0].args).toMatchObject({ path: null });
  await emit(page, input.requestId, { type: "delta", text: "已取消文件操作，我们可以继续聊。" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
});

test("tool progress and results appear inside the same conversation", async ({ page }) => {
  await installAgentBackend(page); const input = await start(page);
  await emit(page, "stale", { type: "delta", text: "旧请求不该出现" });
  await emit(page, input.requestId, { type: "tool-start", tool: "read", toolCallId: "read-1", arguments: { path: "README.md" } });
  await emit(page, input.requestId, { type: "tool-end", tool: "read", toolCallId: "read-1", output: "项目说明", isError: false });
  await emit(page, input.requestId, { type: "delta", text: "已读取说明。" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByText("旧请求不该出现")).toHaveCount(0);
  await page.locator(".agent-activity__details > summary").click();
  await page.locator(".agent-activity__tool > summary").click();
  await expect(page.locator(".agent-activity__tool").getByText("项目说明", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
});

for (const allowed of [true, false]) test(`inline command confirmation ${allowed ? "allows" : "denies"} then continues`, async ({ page }) => {
  await installAgentBackend(page); const input = await start(page);
  await emit(page, input.requestId, { type: "approval", approvalId: "a", tool: "bash", arguments: { command: "pwd" } });
  const card = page.getByRole("region", { name: "操作确认" });
  await expect(card.getByRole("button", { name: "允许此次操作" })).toBeInViewport({ ratio: 1 });
  expect(await calls(page, "agent_approve")).toHaveLength(0);
  await card.getByRole("button", { name: allowed ? "允许此次操作" : "拒绝", exact: true }).click();
  expect((await calls(page, "agent_approve"))[0].args).toEqual({ requestId: input.requestId, approvalId: "a", allowed });
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await emit(page, input.requestId, { type: "completed" });
});

test("business confirmation stays in the same Pi conversation", async ({ page }) => {
  await installAgentBackend(page); const input = await start(page, "帮我记一下下周看展");
  await emit(page, input.requestId, { type: "action-proposed", draft: { id: "memo-draft", pluginId: "piko.memos", toolName: "create_memo", summary: "创建备忘录：下周看展", arguments: { title: "下周看展" }, createdAt: 1 } });
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  expect((await calls(page, "agent_confirm_action"))[0].args).toMatchObject({ requestId: input.requestId, id: "memo-draft" });
  expect(await calls(page, "confirm_chat_action")).toHaveLength(0);
  await emit(page, input.requestId, { type: "delta", text: "已帮你记下。" });
  await emit(page, input.requestId, { type: "completed" });
  const next = await start(page, "也提醒我一下");
  expect(next.conversationId).toBe(input.conversationId);
});

test("Escape hides the window while the active task continues", async ({ page }) => {
  await installAgentBackend(page); const input = await start(page);
  await page.getByLabel("发送给 Piko 的问题").press("Escape");
  await expect.poll(() => calls(page, "hide_bubble")).toHaveLength(1);
  expect(await calls(page, "agent_cancel")).toHaveLength(0);
  expect(await calls(page, "chat_cancel")).toHaveLength(0);
  await emit(page, input.requestId, { type: "delta", text: "收起后任务仍可完成。" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByText("收起后任务仍可完成。", { exact: true }).first()).toBeVisible();
});

test("explicit stop cancels the active task without starting a second engine", async ({ page }) => {
  await installAgentBackend(page); const input = await start(page);
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect.poll(() => calls(page, "agent_cancel")).toHaveLength(1);
  expect(await calls(page, "chat_cancel")).toHaveLength(0);
  await emit(page, input.requestId, { type: "cancelled" });
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
});

test("reload and directory changes preserve the conversation; new chat resets it", async ({ page }) => {
  await installAgentBackend(page); const first = await start(page, "记住摄影");
  await emit(page, first.requestId, { type: "completed" });
  await page.reload();
  await page.getByRole("button", { name: /^📁/ }).click();
  const resumed = await start(page, "继续分析");
  expect(resumed.conversationId).toBe(first.conversationId);
  expect(resumed.cwd).toBe("/tmp/piko-agent-ui-test");
  await emit(page, resumed.requestId, { type: "completed" });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const fresh = await start(page, "新问题");
  expect(fresh.conversationId).not.toBe(first.conversationId); expect(fresh.importHistory).toBe(false);
});

test("completed turns remain in the thread once each after a follow-up", async ({ page }) => {
  await installAgentBackend(page);
  const first = await start(page, "第一轮问题");
  await emit(page, first.requestId, { type: "delta", text: "第一轮回答" });
  await emit(page, first.requestId, { type: "completed" });
  await expect(page.getByText("第一轮问题", { exact: true })).toHaveCount(1);
  const second = await start(page, "第二轮追问");
  await emit(page, second.requestId, { type: "delta", text: "第二轮回答" });
  await emit(page, second.requestId, { type: "completed" });
  await expect(page.getByText("第一轮问题", { exact: true })).toHaveCount(1);
  await expect(page.getByText("第二轮追问", { exact: true })).toHaveCount(1);
});

test("failed startup restores the single input draft", async ({ page }) => {
  await installAgentBackend(page); await bridge(page, "error", "Agent 运行时未准备好");
  await page.getByLabel("发送给 Piko 的问题").fill("检查文件");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveValue("检查文件");
  await expect(page.getByText(/Agent 运行时未准备好/)).toBeVisible();
});

test("Ctrl+Enter sends through the same agent engine", async ({ page }) => {
  await installAgentBackend(page);
  await page.getByLabel("发送给 Piko 的问题").fill("你好");
  await page.getByLabel("发送给 Piko 的问题").press("Control+Enter");
  await expect.poll(() => calls(page, "agent_start")).toHaveLength(1);
  expect(await calls(page, "chat_start")).toHaveLength(0);
});

for (const viewport of [{ width: 480, height: 420 }, { width: 360, height: 300 }]) {
  test(`one composer and approval fit at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await installAgentBackend(page);
    await bridge(page, "directory", `/tmp/${"very-long-directory/".repeat(8)}`);
    await page.getByRole("button", { name: /^📁/ }).click();
    const input = await start(page);
    await emit(page, input.requestId, { type: "approval", approvalId: "long", tool: "write", arguments: { path: "file.txt", content: "x".repeat(2000) } });
    await expect(page.getByRole("button", { name: "允许此次操作" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "停止生成" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("textbox")).toHaveCount(1);
    const layout = await page.evaluate(() => [".bubble-shell", ".bubble-input-zone", ".chat-workspace", ".agent-activity"].map((selector) => {
      const e = document.querySelector(selector)!; return { selector, width: e.getBoundingClientRect().width, client: e.clientWidth, scroll: e.scrollWidth };
    }));
    for (const e of layout) { expect(e.width, e.selector).toBeLessThanOrEqual(viewport.width); expect(e.scroll, e.selector).toBeLessThanOrEqual(e.client + 1); }
    await page.screenshot({ path: testInfo.outputPath("unified-approval.png"), fullPage: true });
  });
}


async function completedReply(page: Page) {
  const input = await start(page, "输出一段自动化测试内容");
  await emit(page, input.requestId, { type: "delta", text: "自动化回复：可以朗读和保存。" });
  await emit(page, input.requestId, { type: "completed" });
  await expect(page.getByRole("button", { name: "朗读回复", exact: true })).toBeVisible();
}

test("reply toolbar copies isolated text and starts and stops native speech", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { (window as unknown as { __copied: string }).__copied = text; },
  } }));
  await installAgentBackend(page);
  await completedReply(page);
  await page.getByRole("button", { name: "复制结果", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe("自动化回复：可以朗读和保存。");
  await page.getByRole("button", { name: "朗读回复", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止朗读", exact: true })).toBeVisible();
  expect((await calls(page, "speak_local_text"))[0].args).toEqual({ text: "自动化回复：可以朗读和保存。" });
  await page.getByRole("button", { name: "停止朗读", exact: true }).click();
  expect(await calls(page, "stop_local_speech")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "朗读回复", exact: true })).toBeVisible();
});

test("reply save carries the full text and defaults to no overwrite", async ({ page }) => {
  await installAgentBackend(page); await completedReply(page);
  await page.evaluate(() => { (window as any).__agentTest.savePath = "/isolated-ui-test/reply.md"; });
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect.poll(() => calls(page, "save_generated_text")).toHaveLength(1);
  expect((await calls(page, "save_generated_text"))[0].args).toEqual({ path: "/isolated-ui-test/reply.md", content: "自动化回复：可以朗读和保存。", overwrite: false });
});

test("cancelling the reply file picker never writes", async ({ page }) => {
  await installAgentBackend(page); await completedReply(page);
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect.poll(() => calls(page, "plugin:dialog|save")).toHaveLength(1);
  expect(await calls(page, "save_generated_text")).toHaveLength(0);
});

for (const approve of [false, true]) test(`reply overwrite requires explicit ${approve ? "approval" : "rejection"}`, async ({ page }) => {
  await installAgentBackend(page); await completedReply(page);
  await page.evaluate(() => { const state = (window as any).__agentTest; state.savePath = "/isolated-ui-test/existing.md"; state.saveError = "目标文件已存在"; });
  page.once("dialog", async dialog => { expect(dialog.type()).toBe("confirm"); if (approve) await dialog.accept(); else await dialog.dismiss(); });
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect.poll(() => calls(page, "save_generated_text")).toHaveLength(approve ? 2 : 1);
  expect((await calls(page, "save_generated_text")).map(call => call.args.overwrite)).toEqual(approve ? [false, true] : [false]);
});

test("attachment picker, remove and screenshot entry use native command boundaries", async ({ page }) => {
  await installAgentBackend(page);
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await expect(page.getByText(/ui-test.md/)).toBeVisible();
  expect((await calls(page, "prepare_text_attachment"))[0].args).toEqual({ path: "/tmp/piko-agent-ui-test" });
  await page.getByRole("button", { name: "移除附件", exact: true }).click();
  await expect(page.getByRole("button", { name: "移除附件", exact: true })).toHaveCount(0);
  expect(await calls(page, "clear_text_attachment")).toHaveLength(1);
  await page.getByRole("button", { name: "截图提问", exact: true }).click();
  expect(await calls(page, "begin_screen_capture")).toHaveLength(1);
});
