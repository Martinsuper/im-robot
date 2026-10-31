import { parseCommand, eventEnvelope } from "./protocol.mjs";
import { randomUUID } from "node:crypto";
import { FileOperations } from "./file-operations.mjs";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ApprovalGate, needsApproval, taskNeedsApproval, isWithin } from "./permissions.mjs";
import { executePrompt } from "./execution.mjs";
import { AppToolBridge, applicationTools } from "./app-tools.mjs";
import { execFile } from "node:child_process";

// stdout is exclusively JSONL; dependencies must never write diagnostics there.
console.log = (...args) => console.error(...args);
const emit = (event) => process.stdout.write(`${JSON.stringify(eventEnvelope(event, activeInput?.requestId))}\n`);
const bridge = new AppToolBridge(emit);
let gate = new ApprovalGate(emit);
let session;
let running = false;
let activeFileOperations;
let activeInput;
let steeringJobs = [];
let cancelled = false;
let unsubscribe;
let initializing = false;
// —— 委托任务（taskKind=coding）编排状态：一个进程一个任务，start 时逐项重置 ——
let codingTask = false;
let taskPolicy;              // 任务级策略（contract 命令可用用户档位覆盖）
let guidanceQueue = [];      // guidance 转向：下一里程碑边界注入，不吊销授权
let budgetExhausted = false; // 宿主预算耗尽信号（guidance 收尾指令）
let contractWait;            // 等待用户契约裁决 { contractId, resolve, reject }
let toolObserver;            // 黄旗/触碰文件嗅探（由编排器安装）
let deltaCharCount = 0;      // usage 兜底估算：模型输出增量字符数

function toolSetCache(input, buildTools) {
  const cache = new Map();
  return (dir) => {
    let tools = cache.get(dir);
    if (!tools) {
      // 续跑默认禁 shell（companion 现状）；委托 coding 任务恢复 shell，检查点机制照旧。
      tools = buildTools(dir, { readOnly: input.readOnly, resuming: Boolean(input.resumeRoot),
        shell: Boolean(input.resumeRoot) && input.taskKind === "coding" });
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
      deltaCharCount += event.assistantMessageEvent.delta.length;
      publish({ type: "delta", text: event.assistantMessageEvent.delta });
    }
    if (event.type === "tool_execution_start") {
      toolInvocations += 1;
      try { toolObserver?.(event); } catch { /* 黄旗嗅探失败不影响工具执行 */ }
      publish({ type: "tool-start", tool: event.toolName, toolCallId: event.toolCallId, arguments: event.args });
    }
    if (event.type === "tool_execution_end") publish({ type: "tool-end", tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
      verification: event.result?.details?.verification, output: Array.from((event.result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n")).slice(0, 16000).join("") });
  });
  return { unsubscribe, toolCount: () => toolInvocations };
}

// usage 采集：每个模型回合结束后发一次 usage。优先取 SDK 会话消息的 usage，
// 取不到则按 delta 字符数/4 估算；elapsedMs 为该回合耗时（宿主侧累计）。
// 基线取创建时刻的既有消息数，续跑恢复的历史回合不重复上报。
function usageReporter() {
  let reported = [...(session?.messages || [])].filter((message) => message.role === "assistant").length;
  return (milestoneId, fallbackMs = 0) => {
    const assistants = [...(session?.messages || [])].filter((message) => message.role === "assistant");
    const fresh = assistants.slice(reported);
    reported = assistants.length;
    for (const message of fresh) {
      const usage = message.usage;
      const elapsedMs = Math.max(0, Math.round(message.durationMs || fallbackMs || 0));
      if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
        emit({ type: "usage", inputTokens: Math.max(0, Math.round(usage.input)), outputTokens: Math.max(0, Math.round(usage.output)), elapsedMs, ...(milestoneId ? { milestoneId } : {}) });
      } else {
        const estimated = Math.ceil(deltaCharCount / 4);
        deltaCharCount = 0;
        emit({ type: "usage", inputTokens: estimated, outputTokens: estimated, elapsedMs, ...(milestoneId ? { milestoneId } : {}) });
      }
    }
  };
}

// —— 委托任务的进程级小工具：验收命令与 git CLI 均由编排器代码执行，不经模型 ——

// 验收命令：cwd=workspace，超时 10 分钟，输出截尾 4000 字符（保尾部，报错多在末尾）。
function runVerifyCommand(command, cwd) {
  return new Promise((resolve) => {
    execFile(command, { cwd, timeout: 10 * 60_000, shell: true, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = `${stdout?.toString() || ""}\n${stderr?.toString() || ""}`.trim();
      resolve({
        ok: !error, code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        output: text.length > 4000 ? text.slice(-4000) : text,
      });
    });
  });
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout?.toString() || ""}${stderr?.toString() || ""}`.trim() });
    });
  });
}

function lastAssistantText() {
  const message = [...(session?.messages || [])].reverse().find((entry) => entry.role === "assistant");
  return (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function normalizePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    workspaceFiles: value.workspaceFiles === "auto" ? "auto" : "confirm",
    shell: value.shell === "auto" ? "auto" : "confirm",
    outsideWorkspace: "confirm", // v2 恒为 confirm
  };
}

function normalizeContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const milestones = (Array.isArray(value.milestones) ? value.milestones : [])
    .map((milestone, index) => ({
      id: typeof milestone?.id === "string" && milestone.id.trim() ? milestone.id.trim() : `m${index + 1}`,
      title: typeof milestone?.title === "string" ? milestone.title : "",
      acceptance: typeof milestone?.acceptance === "string" ? milestone.acceptance : "",
    }))
    .filter((milestone) => milestone.title.trim().length > 0)
    .slice(0, 8);
  if (typeof value.goal !== "string" || !value.goal.trim() || milestones.length === 0) return null;
  return {
    goal: value.goal.trim(), milestones,
    verifyCommand: typeof value.verifyCommand === "string" ? value.verifyCommand.trim() : "",
    timeMinutes: Number.isFinite(value.timeMinutes) ? value.timeMinutes : undefined,
    risks: Array.isArray(value.risks) ? value.risks.filter((risk) => typeof risk === "string") : [],
    onFailure: value.onFailure === "skip" ? "skip" : "suspend", // 里程碑仍失败：挂起等待用户（默认）或按契约跳过
  };
}

function parseContract(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return normalizeContract(JSON.parse(text.slice(start, end + 1))); } catch { return null; }
}

function waitForContract(contractId) {
  return new Promise((resolve, reject) => { contractWait = { contractId, resolve, reject }; });
}

class ContractRejected extends Error {
  constructor() { super("用户未确认任务契约"); }
}

// —— 委托任务编排器（PRD 04 §4.2）：循环逻辑是代码，模型只负责单步决策 ——
async function runDelegatedTask(input, context) {
  const { events, workspace, drainSteering, reportUsage } = context;
  if (!workspace) throw new Error("委托任务缺少工作目录");
  const taskId = String(input.requestId || "task").slice(0, 64);
  const logPath = path.join(workspace, ".piko", `task-${taskId}.md`);
  const notices = [];
  const milestoneRecords = [];
  const verifyRuns = [];
  const commits = [];
  const touchedFiles = new Set();    // 当前里程碑内任务触碰的文件（git 只 add 这些）
  const reportedUntracked = new Set();
  const git = { enabled: false, branch: "", baseRev: "" };
  let gitMode = ["branch", "files-only"].includes(input.gitMode) ? input.gitMode : "off";
  let suspended = false;
  let suspendReason = "";
  const notice = (level, text) => { notices.push({ level, text }); emit({ type: "notice", level, text }); };

  // 黄旗嗅探与触碰文件记录（尽力而为）：依赖安装、分支操作、计划外新增文件、写/编辑路径。
  toolObserver = (event) => {
    const command = typeof event.args?.command === "string" ? event.args.command : "";
    if (command) {
      if (/(?:^|[\s;&|(])(?:sudo\s+)?(?:npm|pnpm|yarn|bun|pip3?|poetry|uv|conda|cargo|gem|brew|apt(?:-get)?|choco|winget)\s+(?:install|i|add|sync)\b/.test(command)) notice("warn", `安装依赖：${command.slice(0, 160)}`);
      if (/\bgit\s+(?:-C\s+\S+\s+)?(?:branch|checkout|switch|worktree)\b/.test(command) && /(?:\s-[bBdD]\b|\s-[bBdD]$|--delete)/.test(command)) notice("warn", `创建或删除分支：${command.slice(0, 160)}`);
    }
    if (["write", "edit"].includes(event.toolName) && typeof event.args?.path === "string") {
      const target = path.resolve(workspace, event.args.path);
      if (isWithin(workspace, target)) touchedFiles.add(target);
    }
  };

  const readTaskLog = async () => {
    try { return (await readFile(logPath, "utf8")).slice(0, 2000); } catch { return ""; }
  };

  // 1. 契约生成：注入结构化 prompt 要求契约 JSON，解析失败重试一次。
  const contractPrompt = [
    "你现在是委托式任务的执行代理。请先为下面的任务生成执行契约，严格只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
    '契约结构：{"goal":"一句话目标复述","milestones":[{"id":"m1","title":"里程碑标题","acceptance":"该里程碑的验收描述"}],"verifyCommand":"用于验收的 shell 命令","timeMinutes":90,"risks":["希望用户注意的风险点"]}',
    "要求：拆出 3-5 个里程碑，每个里程碑有可检验的验收描述；verifyCommand 是项目级验证命令，若用户或项目未提供则给出最合理的命令，确实没有则留空字符串；risks 列出执行中需要用户注意的风险（没有则空数组）。",
    `用户任务：${input.prompt}`,
    `工作目录：${workspace}`,
  ].join("\n");
  let contract;
  for (let attempt = 0; attempt < 2 && !contract && !cancelled; attempt += 1) {
    const turnStart = Date.now();
    await session.prompt(attempt === 0 ? contractPrompt : `${contractPrompt}\n\n上一次输出无法解析为契约 JSON。请严格只输出一个 JSON 对象，不要任何其他文字或代码块标记。`);
    reportUsage(undefined, Date.now() - turnStart);
    contract = parseContract(lastAssistantText());
  }
  if (cancelled) throw new Error("任务已取消");
  if (!contract) throw new Error("契约生成失败：模型未能输出有效的任务契约 JSON");
  const contractId = randomUUID();
  emit({ type: "contract-proposed", contractId, contract });
  // 挂起等待 contract 命令（宿主在契约等待期间不计任务预算）。
  const ruling = await waitForContract(contractId);
  if (!ruling.approved) throw new ContractRejected();
  // 以回传对象为准：用户可编辑里程碑与验收命令；policy/gitMode 用宿主解析后的用户选择。
  contract = normalizeContract(ruling.contract) || contract;
  if (["branch", "files-only", "off"].includes(ruling.gitMode)) gitMode = ruling.gitMode;
  taskPolicy = normalizePolicy(ruling.policy) || taskPolicy;

  // 2. git 安全网：编排器直接执行 git CLI，绝不 push；非 git 仓库降级并在回执注明。
  if (gitMode !== "off") {
    const inside = await runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.ok && inside.output === "true") {
      git.enabled = true;
      if (gitMode === "branch") {
        const status = await runGit(workspace, ["status", "--porcelain"]);
        if (status.ok && status.output === "") {
          const branch = `piko/task-${taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 4) || randomUUID().slice(0, 4)}`;
          const created = await runGit(workspace, ["checkout", "-b", branch]);
          if (created.ok) { git.branch = branch; notice("info", `已创建任务分支 ${branch}，任务提交隔离在该分支上。`); }
          else notice("warn", `创建任务分支失败：${created.output.slice(0, 160)}`);
        } else notice("warn", "工作区存在未提交改动，未创建任务分支，按仅提交任务触碰文件处理。");
      }
      const head = await runGit(workspace, ["rev-parse", "HEAD"]);
      if (head.ok) git.baseRev = head.output;
    } else notice("info", "当前工作目录不是 git 仓库，git 安全网未启用，回执将注明。");
  }

  const collectUnplannedFiles = async () => {
    if (!git.enabled) return;
    const status = await runGit(workspace, ["status", "--porcelain", "-uall"]);
    if (!status.ok) return;
    const added = status.output.split("\n").filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim()).filter((file) => file && !file.startsWith(".piko/") && !reportedUntracked.has(file));
    for (const file of added) reportedUntracked.add(file);
    if (added.length) notice("info", `计划外新增文件（未在契约内声明）：${added.join("、")}`);
  };

  // 里程碑验收通过后：仅 add 任务触碰的文件并提交；绝不 push。
  const commitMilestone = async (milestone) => {
    const files = [...touchedFiles];
    touchedFiles.clear();
    if (!git.enabled || files.length === 0) return;
    const add = await runGit(workspace, ["add", "--", ...files]);
    if (!add.ok) { notice("warn", `git add 失败：${add.output.slice(0, 160)}`); return; }
    const staged = await runGit(workspace, ["diff", "--cached", "--quiet"]);
    if (staged.ok) return; // 触碰文件与 HEAD 一致，不产生空提交
    const commit = await runGit(workspace, ["commit", "-m", `piko(task): ${milestone.id} ${milestone.title}`.slice(0, 200)]);
    if (!commit.ok) { notice("warn", `git commit 失败：${commit.output.slice(0, 160)}`); return; }
    const hash = await runGit(workspace, ["rev-parse", "--short", "HEAD"]);
    if (hash.ok) commits.push(hash.output);
  };

  const collectFilesChanged = async () => {
    if (!git.enabled) return [];
    const diff = await runGit(workspace, ["diff", "--numstat", git.baseRev || "HEAD"]);
    if (!diff.ok) return [];
    return diff.output.split("\n").filter(Boolean).map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      return { path: rest.join("\t"), added: added === "-" ? 0 : Number(added) || 0, removed: removed === "-" ? 0 : Number(removed) || 0 };
    });
  };

  const verifyTarget = () => {
    const command = [contract.verifyCommand, input.verifyCommand].find((value) => typeof value === "string" && value.trim());
    return command ? command.trim() : "";
  };

  // 3. 里程碑循环：started → 执行 → 验收（编排器直跑）→ completed / 自诊断重试 / failed(挂起|跳过)。
  for (const milestone of contract.milestones) {
    if (cancelled) throw new Error("任务已取消");
    // 里程碑边界让 stdin 事件落地：guidance 与预算收尾在进入下一里程碑前生效。
    await new Promise((resolve) => setImmediate(resolve));
    if (budgetExhausted) { suspended = true; suspendReason = "任务预算即将耗尽，编排器已收尾，剩余里程碑未执行。"; break; }
    const record = { id: milestone.id, title: milestone.title, status: "started", note: "" };
    milestoneRecords.push(record);
    emit({ type: "milestone", milestoneId: milestone.id, status: "started", title: milestone.title });
    let verification = null;
    // 初次执行 + 最多 2 次自诊断重试（消耗预算），验收命令失败报错注入下一轮。
    for (let attempt = 0; attempt < 3 && !cancelled && !budgetExhausted; attempt += 1) {
      const guidance = guidanceQueue.splice(0);
      const logExcerpt = await readTaskLog();
      const sections = [
        `任务契约目标：${contract.goal}`,
        attempt === 0 ? `现在执行里程碑 ${milestone.id}：${milestone.title}`
          : `里程碑 ${milestone.id}（${milestone.title}）上一次验收未通过，请根据验收报告自诊断并修复，然后再次完成该里程碑：\n验收命令：${verification.command}\n退出码：${verification.code}\n输出（尾部）：\n${verification.output}`,
        milestone.acceptance ? `里程碑验收要求：${milestone.acceptance}` : "",
        verifyTarget() ? `任务验收命令（编排器将在里程碑结束后自动执行，不要自行运行或伪造其结果）：${verifyTarget()}` : "",
        guidance.length ? `用户补充指示（guidance，优先遵循，不改变契约目标）：\n${guidance.join("\n")}` : "",
        logExcerpt ? `任务日志当前内容（继续维护，保留既有记录）：\n${logExcerpt}` : "",
        `执行纪律：1) 实际调用工具完成该里程碑，不要只输出计划或等待确认；2) 更新任务日志 .piko/task-${taskId}.md（已完成/下一步/疑问三节）；3) 只在工作目录 ${workspace} 内读写文件，安装依赖、创建计划外文件、创建或删除分支前先说明原因；4) 不要执行 git push，也不要自行提交，git 由编排器统一处理。`,
      ].filter(Boolean);
      const turnStart = Date.now();
      await executePrompt(session, sections.join("\n\n"), { toolCount: events.toolCount, cancelled: () => cancelled, emit, taskKind: "coding" });
      reportUsage(milestone.id, Date.now() - turnStart);
      await drainSteering();
      if (cancelled) throw new Error("任务已取消");
      const command = verifyTarget();
      if (!command) { verification = { command: "", code: 0, output: "", ok: true }; break; }
      const result = await runVerifyCommand(command, workspace);
      verification = { ...result, command };
      verifyRuns.push({ command, ok: result.ok, output: result.output });
      if (result.ok) break;
    }
    if (cancelled) throw new Error("任务已取消");
    if (verification?.ok) {
      record.status = "completed";
      record.note = verification.command ? `验收通过：${verification.command}` : "未配置验收命令，按执行完成处理";
      emit({ type: "milestone", milestoneId: milestone.id, status: "completed", title: milestone.title });
      await collectUnplannedFiles();
      await commitMilestone(milestone);
    } else if (budgetExhausted) {
      record.status = "failed";
      record.note = "任务预算耗尽，里程碑未完成验收";
      emit({ type: "milestone", milestoneId: milestone.id, status: "failed", title: milestone.title });
      suspended = true;
      suspendReason = "任务预算即将耗尽，编排器已收尾。";
      break;
    } else {
      record.status = "failed";
      record.note = verification ? `验收失败：${verification.command}（退出码 ${verification.code}）` : "执行未完成";
      emit({ type: "milestone", milestoneId: milestone.id, status: "failed", title: milestone.title, ...(verification?.output ? { note: verification.output.slice(-300) } : {}) });
      if (contract.onFailure === "skip") {
        record.status = "skipped";
        emit({ type: "milestone", milestoneId: milestone.id, status: "skipped", title: milestone.title });
      } else {
        suspended = true;
        suspendReason = `里程碑 ${milestone.id} 验收未通过，任务已挂起等待用户处理。`;
        break;
      }
    }
  }

  // 4. 收尾：挂起/预算耗尽时也可能有未提交的触碰文件，先提交当前进度。
  if (git.enabled && touchedFiles.size > 0) await commitMilestone({ id: "wrap-up", title: "任务收尾提交" });
  else touchedFiles.clear();

  // 5. 回执（receipt 事件之后紧跟终态事件，顺序固定，doc 18 §4）。
  const records = [...milestoneRecords];
  for (const milestone of contract.milestones) {
    if (!records.some((entry) => entry.id === milestone.id)) records.push({ id: milestone.id, title: milestone.title, status: "pending", note: "未执行" });
  }
  const completed = records.filter((entry) => entry.status === "completed").length;
  const openQuestions = [];
  for (const entry of records) {
    if (entry.status === "failed") openQuestions.push(`里程碑 ${entry.id}（${entry.title}）未通过：${entry.note}`);
    else if (entry.status === "skipped") openQuestions.push(`里程碑 ${entry.id}（${entry.title}）已跳过，需要人工确认`);
    else if (entry.status === "pending") openQuestions.push(`里程碑 ${entry.id}（${entry.title}）未执行`);
  }
  if (suspended) openQuestions.push(suspendReason);
  // 预算收尾时队列里只剩宿主的收尾指令本身；其余挂起场景下未消费的 guidance 要显式告知用户。
  const leftoverGuidance = budgetExhausted ? [] : guidanceQueue.splice(0);
  if (leftoverGuidance.length) openQuestions.push(`还有 ${leftoverGuidance.length} 条用户补充指示（guidance）未注入执行，续跑时请优先处理。`);
  if (!git.enabled && gitMode !== "off") openQuestions.push("git 安全网未启用：工作目录不是 git 仓库，改动未提交。");
  else if (gitMode === "off") openQuestions.push("gitMode=off：未启用 git 安全网，改动未提交。");
  const summary = `契约目标：${contract.goal}；里程碑完成 ${completed}/${contract.milestones.length}` + (suspended ? "；任务挂起" : "")
    + (git.branch ? `；分支 ${git.branch}` : "") + (commits.length ? `；提交 ${commits.length} 个` : "") + "。";
  emit({ type: "receipt", status: suspended ? "suspended" : "completed", summary, receipt: {
    milestones: records, filesChanged: await collectFilesChanged(), verify: verifyRuns, notices,
    branch: git.branch, commits, openQuestions,
  } });
}

async function start(input) {
  if (running) throw new Error("已有任务正在运行");
  running = true; activeInput = input;
  cancelled = false; steeringJobs = [];
  // 委托任务状态逐任务重置；审批超时：委托 coding 任务 30 分钟，其余维持 5 分钟。
  codingTask = input.taskKind === "coding";
  taskPolicy = codingTask ? normalizePolicy(input.policy) : undefined;
  guidanceQueue = []; budgetExhausted = false; contractWait = undefined; toolObserver = undefined;
  deltaCharCount = 0;
  gate = new ApprovalGate(emit, codingTask ? 30 * 60_000 : 5 * 60_000);
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
        // coding 任务按 taskNeedsApproval（任务级策略）裁决；companion 走现状路径。
        const approvalCheck = (name, toolArgs) => codingTask && taskPolicy
          ? taskNeedsApproval(name, toolArgs, workspace, taskPolicy, Boolean(input.autoApproveCommands))
          : needsApproval(name, toolArgs, workspace, input.passport ? false : input.autoApproveCommands);
        const approve = async () => { if (approved) return; if (await approvalCheck(tool.name, args)) await gate.request(tool.name, args, signal); if (signal?.aborted) throw new Error("操作已取消"); approved = true; };
        const run = () => { if (signal?.aborted) throw new Error("操作已取消"); return toolsFor(workspace)[index].execute(id, args, signal, onUpdate, { ...context, cwd: workspace }); };
        if (input.serializeSystemTools) await bridge.request("piko_acquire_system_tools", {}, signal);
        try {
          if (["write", "edit"].includes(tool.name) && await approvalCheck("read", args)) await approve();
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
    const reportUsage = usageReporter();
    const drainSteering = async () => {
      await Promise.all(steeringJobs);
      while (!cancelled && session.pendingMessageCount > 0) {
        const queued = session.clearQueue();
        const turnStart = Date.now();
        await executePrompt(session, [...queued.steering, ...queued.followUp].join("\n"), { toolCount: events.toolCount, cancelled: () => cancelled, emit, taskKind: codingTask ? "coding" : undefined });
        reportUsage(undefined, Date.now() - turnStart);
        await Promise.all(steeringJobs);
      }
    };
    if (codingTask) await runDelegatedTask(input, { events, workspace, drainSteering, reportUsage });
    else {
      const turnStart = Date.now();
      await executePrompt(session, input.prompt, { toolCount: events.toolCount, cancelled: () => cancelled, emit, images: input.images });
      reportUsage(undefined, Date.now() - turnStart);
      await drainSteering();
    }
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (cancelled) emit({ type: "cancelled" });
    else if (last?.stopReason === "error" || last?.stopReason === "aborted") {
      emit({ type: "failed", message: last.errorMessage || "模型请求失败" });
    } else emit({ type: "completed", sessionId: session.sessionId });
  } catch (error) {
    if (error instanceof ContractRejected) emit({ type: "cancelled", message: "用户未确认任务契约" });
    else emit(cancelled ? { type: "cancelled" } : { type: "failed", message: error.message });
  } finally {
    clearTimeout(startupTimer);
    initializing = false;
    gate.cancel();
    bridge.cancel();
    unsubscribe?.();
    session?.dispose();
    session = undefined;
    toolObserver = undefined;
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
    else if (input.type === "contract") {
      if (!contractWait || contractWait.contractId !== input.contractId) throw new Error("当前没有等待该标识的任务契约");
      const wait = contractWait;
      contractWait = undefined;
      wait.resolve(input);
    }
    else if (input.type === "steer") {
      if (!session || !running) throw new Error("当前没有可补充的任务");
      if (input.mode === "guidance") {
        // guidance：入队等下一里程碑边界注入；不吊销授权、不关闭自动批准（redirect 保持现状）。
        // 宿主预算耗尽的收尾指令据此触发优雅收尾（提交进度 + receipt(suspended)）。
        // doc 18 §9：reason==="budget" 为权威收尾信号；文本匹配仅作旧宿主回退。
        const text = input.text;
        if (input.reason === "budget" || (typeof text === "string" && /预算即将耗尽|请收尾/.test(text))) budgetExhausted = true;
        if (codingTask) { guidanceQueue.push(text); emit({ type: "steering-accepted", text }); }
        else {
          // companion 没有里程碑边界：立即经 SDK 注入，但同样不吊销授权。
          const job = session.steer(text).then(() => emit({ type: "steering-accepted", text })).catch((error) => emit({ type: "protocol-error", message: error.message }));
          steeringJobs.push(job);
        }
      } else {
        if (activeInput) activeInput.autoApproveCommands = false;
        // Queue the correction and revoke old approvals before the next mutation can run.
        const revocation = activeFileOperations?.revokeAuthorization();
        const delivery = session.steer(input.text);
        gate.cancel(); bridge.cancel();
        const job = Promise.all([revocation, delivery]).then(() => emit({ type: "steering-accepted", text: input.text })).catch((error) => emit({ type: "protocol-error", message: error.message }));
        steeringJobs.push(job);
      }
    }
    else if (input.type === "approval") {
      try { gate.reply(input.approvalId, input.allowed); }
      catch (error) { emit({ type: "approval-expired", approvalId: input.approvalId, message: error.message }); }
    }
    else if (input.type === "app-result") bridge.reply(input.callId, input.result, input.error);
    else if (input.type === "cancel") {
      cancelled = true;
      contractWait?.reject(new Error("任务已取消"));
      contractWait = undefined;
      gate.cancel();
      bridge.cancel();
      if (initializing) {
        process.stdout.write(`${JSON.stringify(eventEnvelope({ type: "cancelled" }, activeInput?.requestId))}\n`, () => process.exit(0));
      } else void session?.abort();
    } else throw new Error("未知的 Agent 指令");
  } catch (error) { emit({ type: "protocol-error", message: error.message }); }
});
lines.on("close", () => { if (running) { cancelled = true; contractWait?.reject(new Error("任务已取消")); contractWait = undefined; gate.cancel(); bridge.cancel(); void session?.abort(); } });
