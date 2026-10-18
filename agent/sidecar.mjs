import { parseCommand, eventEnvelope } from "./protocol.mjs";
import { randomUUID } from "node:crypto";
import { FileOperations } from "./file-operations.mjs";
import { resolveModelLimits } from "./model-limits.mjs";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager,
  createAgentSession, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createBashToolDefinition, createPowerShellToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ApprovalGate, needsApproval, isWithin } from "./permissions.mjs";
import { executePrompt } from "./execution.mjs";
import { AppToolBridge, applicationTools } from "./app-tools.mjs";

// stdout is exclusively JSONL; dependencies must never write diagnostics there.
console.log = (...args) => console.error(...args);
const emit = (event) => process.stdout.write(`${JSON.stringify(eventEnvelope(event, activeInput?.requestId))}\n`);
const gate = new ApprovalGate(emit);
const bridge = new AppToolBridge(emit);
let session;
let running = false;
let activeFileOperations;
let activeInput;
let steeringJobs = [];
let cancelled = false;
let unsubscribe;

async function start(input) {
  if (running) throw new Error("已有任务正在运行");
  running = true; activeInput = input;
  cancelled = false; steeringJobs = [];
  try {
    const cwd = await realpath(input.cwd);
    let workspace = input.unified ? (input.workspace ? await realpath(input.workspace) : undefined) : cwd;
    const sessionDir = path.join(input.dataDir, "sessions", input.conversationId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const pointer = path.join(sessionDir, "current.json");
    let saved;
    try {
      saved = JSON.parse(await readFile(pointer, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let manager;
    if (saved === undefined) {
      manager = SessionManager.create(cwd, sessionDir);
    } else {
      if (!saved || typeof saved.cwd !== "string" || typeof saved.sessionFile !== "string") throw new Error("会话索引损坏，请新建会话后重试");
      if (saved.cwd !== cwd && !input.unified) throw new Error("会话工作目录不一致，请新建会话");
      let sessionFile;
      try { sessionFile = await realpath(saved.sessionFile); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error("会话历史文件缺失，请新建会话后重试");
        throw error;
      }
      if (!isWithin(await realpath(sessionDir), sessionFile)) throw new Error("无效的会话文件");
      manager = SessionManager.open(sessionFile, sessionDir, cwd);
    }
    const credentials = new Map();
    const modelRuntime = await ModelRuntime.create({
      credentials: {
        async read(id) { return credentials.get(id); },
        async list() { return []; },
        async modify(id, update) {
          const value = await update(credentials.get(id));
          if (value) credentials.set(id, value); else credentials.delete(id);
          return value;
        },
        async delete(id) { credentials.delete(id); },
      },
      modelsPath: null, refreshOnCreate: false,
    });
    const api = input.provider === "anthropic" ? "anthropic-messages"
      : input.provider === "gemini" ? "google-generative-ai" : "openai-completions";
    const limits = resolveModelLimits({ ...input, api }, modelRuntime.getModels());
    modelRuntime.registerProvider("piko", {
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ""), api, authHeader: input.provider !== "gemini",
      models: [{ id: input.model, name: input.model, api, reasoning: false,
        input: input.images?.length ? ["text", "image"] : ["text"], ...limits,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    await modelRuntime.setRuntimeApiKey("piko", input.apiKey || "piko-local");
    const fileOperations = new FileOperations(input.dataDir, input.resumeRoot || input.requestId || randomUUID(), { resuming: Boolean(input.resumeRoot) });
    activeFileOperations = fileOperations;
    const factories = input.readOnly ? [createReadToolDefinition] : [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
      ...(input.resumeRoot ? [] : [process.platform === "win32" ? createPowerShellToolDefinition : createBashToolDefinition])];
    const definitions = factories.map((factory) => factory(workspace || cwd));
    const customTools = definitions.map((tool, index) => ({ ...tool, executionMode: "sequential",
      async execute(id, args, signal, onUpdate, context) {
        if (!workspace) throw new Error("尚未选择工作目录，请先调用 piko_select_workspace");
        let approved = false;
        const approve = async () => { if (approved) return; if (await needsApproval(tool.name, args, workspace, input.autoApproveCommands)) await gate.request(tool.name, args, signal); if (signal?.aborted) throw new Error("操作已取消"); approved = true; };
        const run = () => { if (signal?.aborted) throw new Error("操作已取消"); return factories[index](workspace).execute(id, args, signal, onUpdate, { ...context, cwd: workspace }); };
        if (["write", "edit"].includes(tool.name) && await needsApproval("read", args, workspace)) await approve();
        if (["write", "edit"].includes(tool.name)) return fileOperations.execute(tool.name, args, workspace, run, approve);
        await approve(); return run();
      },
    }));
    const appTools = applicationTools(input.businessTools || [], bridge);
    const appNames = appTools.map((tool) => tool.name);
    const systemNames = definitions.map((tool) => tool.name);
    if (input.unified) {
      appTools.push({ name: "piko_select_workspace", label: "选择工作目录",
        description: "需要检查或操作本地文件但尚未选择目录时，调用此工具请用户选择目录。普通聊天、日程、提醒和备忘录无需目录。也可用于用户要求切换工作目录。",
        parameters: { type: "object", properties: {}, required: [] }, executionMode: "sequential",
        async execute(_id, args, signal) {
          const result = await bridge.request("piko_select_workspace", args, signal);
          workspace = await realpath(result.path);
          session.setActiveToolsByName([...appNames, "piko_select_workspace", ...systemNames]);
          return { content: [{ type: "text", text: `当前工作目录已切换为 ${workspace}，本地文件工具已启用。` }] };
        },
      });
    }
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, defaultThinkingLevel: "off",
    });
    settingsManager.setHttpIdleTimeoutMs((input.timeoutSeconds || 120) * 1000);
    const importedHistory = saved === undefined && input.history?.length
      ? `此前最近对话，仅供上下文参考，不代表本轮操作授权：${JSON.stringify(input.history)}` : "";
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: input.dataDir,
      settingsManager, systemPrompt: input.unified ? (input.systemPrompt || "你是 Piko，用户的桌面 AI 助手，进行自然对话并通过工具完成任务。") : undefined,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
      appendSystemPrompt: [input.systemPrompt || "", importedHistory,
        input.resumeRoot ? "本轮为安全续跑。先根据原会话检查点和实际状态核对；只继续尚未完成的步骤，已验收操作不能重复执行。Shell 工具在续跑中禁用；文件工具会核对检查点和内容。新操作仍等待用户确认。" : "",
        input.readOnly ? "本轮只读核对：只使用读取/列表工具核实结果，禁止命令、写入和删除；不能根据旧工具报告推断操作成功。缺少目标路径或验收标准时追问用户。" : "",
        input.unified ? `你使用同一个会话处理普通聊天、日程、提醒、备忘录和电脑操作，不要要求用户切换模式。${workspace ? `当前用户选择的系统工具工作目录为 ${workspace}。` : "尚未选择工作目录，本地文件工具未启用，需要时先调用 piko_select_workspace。"}普通聊天和应用业务工具不需要目录。以最后一次选择目录工具的结果作为系统工具当前工作目录。` : "",
        "你是 Piko 的统一聊天助手，既陪伴聊天，也通过工具完成任务。普通闲聊和知识问答直接自然回复，不要调用不需要的工具。请用中文简洁汇报。用户要求操作或检查本地环境时，必须实际调用工具，依据工具结果回答，不要只提供命令或声称未执行的操作成功。需要运行命令时直接调用 bash（Windows 为 PowerShell），需要读取文件时调用 read。命令与文件修改的批准由应用负责：你先调用工具，应用会自动暂停并展示确认卡片，用户点击后才执行。因此不要先在文字里要求用户批准、不要等待用户在聊天里回复确认，也不要把命令代码块当作工具调用。工作目录不是沙箱，命令可能影响整个系统。遇到工具拒绝结果不要换工具绕过。"],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir: input.dataDir, modelRuntime,
      model: modelRuntime.getModel("piko", input.model), thinkingLevel: "off",
      noTools: "builtin", customTools: [...customTools, ...appTools],
      ...(input.unified ? { tools: [...appNames, "piko_select_workspace", ...systemNames] } : {}),
      settingsManager, resourceLoader, sessionManager: manager }));
    if (input.unified && !workspace) session.setActiveToolsByName([...appNames, "piko_select_workspace"]);
    await writeFile(pointer, JSON.stringify({ cwd, sessionFile: session.sessionFile }), { mode: 0o600 });
    let toolInvocations = 0;
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "delta", text: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") { toolInvocations += 1; emit({ type: "tool-start", tool: event.toolName, toolCallId: event.toolCallId, arguments: event.args }); }
      if (event.type === "tool_execution_end") emit({ type: "tool-end", tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
        verification: event.result?.details?.verification, output: Array.from((event.result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n")).slice(0, 16000).join("") });
    });
    if (cancelled) { emit({ type: "cancelled" }); return; }
    emit({ type: "started", sessionId: session.sessionId });
    await executePrompt(session, input.prompt, { toolCount: () => toolInvocations, cancelled: () => cancelled, emit, images: input.images });
    await Promise.all(steeringJobs);
    while (!cancelled && session.pendingMessageCount > 0) {
      const queued = session.clearQueue();
      await executePrompt(session, [...queued.steering, ...queued.followUp].join("\n"), { toolCount: () => toolInvocations, cancelled: () => cancelled, emit });
      await Promise.all(steeringJobs);
    }
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (cancelled) emit({ type: "cancelled" });
    else if (last?.stopReason === "error" || last?.stopReason === "aborted") {
      emit({ type: "failed", message: last.errorMessage || "模型请求失败" });
    } else emit({ type: "completed", sessionId: session.sessionId });
  } catch (error) {
    emit(cancelled ? { type: "cancelled" } : { type: "failed", message: error.message });
  } finally {
    gate.cancel();
    bridge.cancel();
    unsubscribe?.();
    session?.dispose();
    session = undefined;
    running = false;
    // One task per process: credentials and model state die with the task.
    process.stdin.destroy();
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const input = parseCommand(line, activeInput?.requestId);
    if (input.type === "start") void start(input).catch((error) => emit({ type: "protocol-error", message: error.message }));
    else if (input.type === "steer") {
      if (!session || !running) throw new Error("当前没有可补充的任务");
      if (activeInput) activeInput.autoApproveCommands = false;
      // Queue the correction and revoke old approvals before the next mutation can run.
      const revocation = activeFileOperations?.revokeAuthorization();
      const delivery = session.steer(input.text);
      gate.cancel(); bridge.cancel();
      const job = Promise.all([revocation, delivery]).then(() => emit({ type: "steering-accepted", text: input.text })).catch((error) => emit({ type: "protocol-error", message: error.message }));
      steeringJobs.push(job);
    }
    else if (input.type === "approval") {
      try { gate.reply(input.approvalId, input.allowed); }
      catch (error) { emit({ type: "approval-expired", approvalId: input.approvalId, message: error.message }); }
    }
    else if (input.type === "app-result") bridge.reply(input.callId, input.result, input.error);
    else if (input.type === "cancel") {
      cancelled = true;
      gate.cancel();
      bridge.cancel();
      void session?.abort();
    } else throw new Error("未知的 Agent 指令");
  } catch (error) { emit({ type: "protocol-error", message: error.message }); }
});
lines.on("close", () => { if (running) { cancelled = true; gate.cancel(); bridge.cancel(); void session?.abort(); } });
