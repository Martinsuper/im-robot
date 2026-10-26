import { parseCommand, eventEnvelope } from "./protocol.mjs";
import { randomUUID } from "node:crypto";
import { FileOperations } from "./file-operations.mjs";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
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
let initializing = false;

function toolSetCache(input, buildTools) {
  const cache = new Map();
  return (dir) => {
    let tools = cache.get(dir);
    if (!tools) {
      tools = buildTools(dir, { readOnly: input.readOnly, resuming: Boolean(input.resumeRoot) });
      cache.set(dir, tools);
    }
    return tools;
  };
}

async function restoreSession(input, cwd, sessionDir, store) {
  const pointer = path.join(sessionDir, "current.json");
  let saved;
  try {
    saved = JSON.parse(await readFile(pointer, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (saved === undefined) return { pointer, saved, manager: store.create(cwd, sessionDir) };
  if (!saved || typeof saved.cwd !== "string" || typeof saved.sessionFile !== "string") throw new Error("会话索引损坏，请新建会话后重试");
  if (saved.cwd !== cwd && !input.unified) throw new Error("会话工作目录不一致，请新建会话");
  let sessionFile;
  try { sessionFile = await realpath(saved.sessionFile); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("会话历史文件缺失，请新建会话后重试");
    throw error;
  }
  if (!isWithin(await realpath(sessionDir), sessionFile)) throw new Error("无效的会话文件");
  return { pointer, saved, manager: store.open(sessionFile, sessionDir, cwd) };
}

function forwardSessionEvents(target, publish) {
  let toolInvocations = 0;
  const unsubscribe = target.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      publish({ type: "delta", text: event.assistantMessageEvent.delta });
    }
    if (event.type === "tool_execution_start") { toolInvocations += 1; publish({ type: "tool-start", tool: event.toolName, toolCallId: event.toolCallId, arguments: event.args }); }
    if (event.type === "tool_execution_end") publish({ type: "tool-end", tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
      verification: event.result?.details?.verification, output: Array.from((event.result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n")).slice(0, 16000).join("") });
  });
  return { unsubscribe, toolCount: () => toolInvocations };
}

async function start(input) {
  if (running) throw new Error("已有任务正在运行");
  running = true; activeInput = input;
  cancelled = false; steeringJobs = [];
  initializing = true;
  // SDK imports and resource discovery precede the HTTP timeout. Bound that
  // phase separately; no prompt or tool has run when this watchdog fires.
  const startupMs = Math.min(30, Math.max(5, input.timeoutSeconds || 30)) * 1000;
  const startupTimer = setTimeout(() => {
    const event = eventEnvelope({ type: "failed", message: "助手初始化超时，尚未发送本轮模型请求或执行工具。请重试；可在故障诊断查看启动阶段。" }, input.requestId);
    process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(1));
  }, startupMs);
  try {
    console.error("[piko] loading SDK");
    const { prepareAgent, SessionStore, fileTools } = await import("./sdk-adapter.mjs");
    if (cancelled) return;
    const cwd = await realpath(input.cwd);
    let workspace = input.unified ? (input.workspace ? await realpath(input.workspace) : undefined) : cwd;
    const sessionDir = path.join(input.dataDir, "sessions", input.conversationId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const { pointer, saved, manager } = await restoreSession(input, cwd, sessionDir, SessionStore);
    console.error("[piko] initializing model runtime");
    const connect = await prepareAgent(input);
    console.error("[piko] model runtime ready");
    const fileOperations = new FileOperations(input.dataDir, input.resumeRoot || input.requestId || randomUUID(), { resuming: Boolean(input.resumeRoot) });
    activeFileOperations = fileOperations;
    const toolsFor = toolSetCache(input, fileTools);
    const definitions = toolsFor(workspace || cwd);
    const customTools = definitions.map((tool, index) => ({ ...tool, executionMode: "sequential",
      async execute(id, args, signal, onUpdate, context) {
        if (!workspace) throw new Error("尚未选择工作目录，请先调用 piko_select_workspace");
        let approved = false;
        const approve = async () => { if (approved) return; if (await needsApproval(tool.name, args, workspace, input.passport?false:input.autoApproveCommands)) await gate.request(tool.name, args, signal); if (signal?.aborted) throw new Error("操作已取消"); approved = true; };
        const run = () => { if (signal?.aborted) throw new Error("操作已取消"); return toolsFor(workspace)[index].execute(id, args, signal, onUpdate, { ...context, cwd: workspace }); };
        if (input.serializeSystemTools) await bridge.request("piko_acquire_system_tools", {}, signal);
        try {
          if (["write", "edit"].includes(tool.name) && await needsApproval("read", args, workspace)) await approve();
          if (["write", "edit"].includes(tool.name)) return await fileOperations.execute(tool.name, args, workspace, run, approve);
          await approve(); return await run();
        } finally {
          if (input.serializeSystemTools) await bridge.request("piko_release_system_tools", {});
        }
      },
    }));
    const appTools = applicationTools(input.businessTools || [], bridge);
    const appNames = appTools.map((tool) => tool.name);
    const systemNames = definitions.map((tool) => tool.name);
    if (input.unified) {
      appTools.push({
        name: "piko_select_workspace", label: "文件工作目录",
        description: input.passport ? "仅在需要文件操作时调用。新建文档或保存生成内容用 generated-files，自动使用文稿/Piko；读取或修改已有文件、项目必须用 existing-files，在电脑选择目标。聊天、日程、提醒、备忘录、专注直接使用业务工具，不需要目录。" : "需要检查或操作本地文件但尚未选择目录时，请用户选择目录。普通聊天、日程、提醒和备忘录无需目录。也可用于切换工作目录。",
        parameters: input.passport ? {type:"object",properties:{purpose:{type:"string",enum:["generated-files","existing-files"]}},required:["purpose"]} : {type:"object",properties:{},required:[]},
        executionMode: "sequential",
        async execute(_id, args, signal) {
          const purpose=args?.purpose ?? "generated-files";
          if(input.passport && !["generated-files","existing-files"].includes(purpose))throw new Error("目录用途无效");
          const result=await bridge.request("piko_select_workspace",input.passport?{purpose}:args,signal);
          workspace=await realpath(result.path);
          session.setActiveToolsByName([...appNames,"piko_select_workspace",...systemNames]);
          return {content:[{type:"text",text:`当前工作目录为 ${workspace}，本地文件工具已启用，操作授权仍单独确认。`}]};
        },
      });
    }
  console.error("[piko] initializing session");
    session = await connect({ cwd, manager, customTools, appTools, appNames, systemNames, saved, workspace });
    console.error("[piko] session ready");
    if (input.unified && (!workspace || input.passport)) session.setActiveToolsByName([...appNames, "piko_select_workspace"]);
    await writeFile(pointer, JSON.stringify({ cwd, sessionFile: session.sessionFile }), { mode: 0o600 });
    const events = forwardSessionEvents(session, emit);
    unsubscribe = events.unsubscribe;
    if (cancelled) { emit({ type: "cancelled" }); return; }
    clearTimeout(startupTimer);
    initializing = false;
    emit({ type: "started", sessionId: session.sessionId });
    console.error("[piko] requesting model");
    await executePrompt(session, input.prompt, { toolCount: events.toolCount, cancelled: () => cancelled, emit, images: input.images });
    await Promise.all(steeringJobs);
    while (!cancelled && session.pendingMessageCount > 0) {
      const queued = session.clearQueue();
      await executePrompt(session, [...queued.steering, ...queued.followUp].join("\n"), { toolCount: events.toolCount, cancelled: () => cancelled, emit });
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
    clearTimeout(startupTimer);
    initializing = false;
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
      if (initializing) {
        process.stdout.write(`${JSON.stringify(eventEnvelope({ type: "cancelled" }, activeInput?.requestId))}\n`, () => process.exit(0));
      } else void session?.abort();
    } else throw new Error("未知的 Agent 指令");
  } catch (error) { emit({ type: "protocol-error", message: error.message }); }
});
lines.on("close", () => { if (running) { cancelled = true; gate.cancel(); bridge.cancel(); void session?.abort(); } });
