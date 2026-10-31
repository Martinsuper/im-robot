import {
  ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager,
  createAgentSession, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createBashToolDefinition, createPowerShellToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveModelLimits } from "./model-limits.mjs";

export const SessionStore = {
  create: (cwd, directory) => SessionManager.create(cwd, directory),
  open: (file, directory, cwd) => SessionManager.open(file, directory, cwd),
};
export function fileTools(cwd, {readOnly=false,resuming=false,shell=false}={}) {
  const shellFactory=process.platform==="win32"?createPowerShellToolDefinition:createBashToolDefinition;
  // 续跑默认不带 shell（companion 现状）；委托 coding 任务恢复 shell，检查点机制照旧。
  const factories=readOnly?[createReadToolDefinition]:[createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,...(resuming&&!shell?[]:[shellFactory])];
  return factories.map(factory=>factory(cwd));
}

// Use the SDK's argument normalization and edit semantics for checkpointing too.
// In-memory operations preserve BOM/line endings and never touch the workspace.
export function normalizeEditArguments(args) {
  return createEditToolDefinition(process.cwd()).prepareArguments({ ...args });
}

export async function previewEdit(content, args) {
  if (content === null) throw new Error("待编辑文件不存在");
  let output;
  const tool = createEditToolDefinition(process.cwd(), { operations: {
    access: async () => {},
    readFile: async () => Buffer.from(content, "utf8"),
    writeFile: async (_path, value) => { output = value; },
  } });
  await tool.execute("checkpoint-preview", args);
  return output;
}
class AgentSession {
  constructor(session) { this.sdk=session; }
  get sessionId() { return this.sdk.sessionId; }
  get sessionFile() { return this.sdk.sessionFile; }
  get messages() { return this.sdk.messages; }
  get pendingMessageCount() { return this.sdk.pendingMessageCount; }
  prompt(...args) { return this.sdk.prompt(...args); }
  steer(...args) { return this.sdk.steer(...args); }
  followUp(...args) { return this.sdk.followUp(...args); }
  abort() { return this.sdk.abort(); }
  clearQueue() { return this.sdk.clearQueue(); }
  subscribe(handler) { return this.sdk.subscribe(handler); }
  setActiveToolsByName(names) { return this.sdk.setActiveToolsByName(names); }
  dispose() { return this.sdk.dispose(); }
}
// coding 专用系统提示（PRD 04 §4.5）：契约与任务日志位置、里程碑纪律、验收纪律、黄旗上报义务、工作区边界。
// 伴侣人格段（统一聊天助手、Passport/统一会话规则）不注入；Rust 侧注入内容由宿主负责。
const codingAssistantNote = (taskId) => `你是 Piko 的委托式任务执行代理，按已确认的任务契约完成编码任务，遵守以下纪律：
- 契约是方向锚点：按里程碑顺序执行，一次只处理当前里程碑，不要提前做后续里程碑的事。
- 任务日志位于 .piko/task-${taskId}.md（工作目录内），维护“已完成 / 下一步 / 疑问”三节，每个里程碑结束时更新。
- 验收命令由编排器在里程碑结束后自动执行，不要自行运行验收命令，更不要伪造其结果。
- 黄旗上报义务：安装依赖、创建计划外文件、创建或删除分支前，先说明原因。
- 工作区边界：只在工作目录内读写文件；不执行 git push；git 提交由编排器统一完成。`;

const CHAT_ASSISTANT_NOTE = "你是 Piko 的统一聊天助手，既陪伴聊天，也通过工具完成任务。普通闲聊和知识问答直接自然回复，不要调用不需要的工具。请用中文简洁汇报。用户要求操作或检查本地环境时，必须实际调用工具，依据工具结果回答，不要只提供命令或声称未执行的操作成功。需要运行命令时直接调用 bash（Windows 为 PowerShell），需要读取文件时调用 read。命令与文件修改的批准由应用负责：你先调用工具，应用会自动暂停并展示确认卡片，用户点击后才执行。因此不要先在文字里要求用户批准、不要等待用户在聊天里回复确认，也不要把命令代码块当作工具调用。工作目录不是沙箱，命令可能影响整个系统。遇到工具拒绝结果不要换工具绕过。";

// coding 任务的 SDK 压缩调优（doc 18 §9）：keepRecentTokens 取 40000 与 contextWindow 一半的较小者，
// reserveTokens 缺省即 SDK 默认 16384；companion 不配置 compaction，完全保持 SDK 默认。
export function codingCompactionSettings(contextWindow) {
  return { enabled: true, keepRecentTokens: Math.min(40000, Math.floor(contextWindow / 2)) };
}

export async function prepareAgent(input) {
  const coding = input.taskKind === "coding";
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

  return async ({ cwd, manager, customTools, appTools, appNames, systemNames, saved, workspace }) => {
    // coding：SDK retry 指数退避重试 2 次；思考档位 medium（SDK 会按模型能力收敛，
    // 不支持 reasoning 的模型自动等效 off）；compaction 按上下文窗口调优（见 codingCompactionSettings）。
    // companion 保持现状（retry 关闭、思考 off、压缩走 SDK 默认）。
    const settingsManager = SettingsManager.inMemory(coding
      ? { retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 }, defaultThinkingLevel: "medium",
          compaction: codingCompactionSettings(limits.contextWindow) }
      : { retry: { enabled: false }, defaultThinkingLevel: "off" });
    settingsManager.setHttpIdleTimeoutMs((input.timeoutSeconds || 120) * 1000);
    const importedHistory = saved === undefined && input.history?.length
      ? `此前最近对话，仅供上下文参考，不代表本轮操作授权：${JSON.stringify(input.history)}` : "";
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: input.dataDir,
      settingsManager, systemPrompt: input.unified ? (input.systemPrompt || "你是 Piko，用户的桌面 AI 助手，进行自然对话并通过工具完成任务。") : undefined,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
      appendSystemPrompt: [input.systemPrompt || "", importedHistory,
        input.resumeRoot ? (coding
          ? "本轮为安全续跑。先根据原会话检查点和实际状态核对；只继续尚未完成的步骤，已验收操作不能重复执行。文件工具会核对检查点和内容。新操作仍按任务策略确认。"
          : "本轮为安全续跑。先根据原会话检查点和实际状态核对；只继续尚未完成的步骤，已验收操作不能重复执行。Shell 工具在续跑中禁用；文件工具会核对检查点和内容。新操作仍等待用户确认。") : "",
        input.readOnly ? "本轮只读核对：只使用读取/列表工具核实结果，禁止命令、写入和删除；不能根据旧工具报告推断操作成功。缺少目标路径或验收标准时追问用户。" : "",
      input.unified ? (input.passport ? "这是 Passport 语音对话。普通聊天、日程、提醒、备忘录和专注直接使用对应业务工具，不要为这些任务选择目录。仅新建文档或保存生成内容时调用 piko_select_workspace，purpose=generated-files，自动使用文稿/Piko；读取或修改已有文件/项目时 purpose=existing-files，在电脑选择目标。启用文件工具不是批准操作，仍需遵守确认流程。未获确认的日程不能说已创建。" : `你使用同一个会话处理普通聊天、日程、提醒、备忘录和电脑操作，不要要求用户切换模式。${workspace ? `当前用户选择的系统工具工作目录为 ${workspace}。` : "尚未选择工作目录，本地文件工具未启用，需要时先调用 piko_select_workspace。"}普通聊天和应用业务工具不需要目录。以最后一次选择目录工具的结果作为当前工作目录。`) : "",
        ...(coding ? [] : [CHAT_ASSISTANT_NOTE]),
        ...(coding ? [codingAssistantNote(input.requestId || "task")] : []),
      ],
    });
    console.error("[piko] loading resources");
    await resourceLoader.reload();
    console.error("[piko] resources loaded");
    console.error("[piko] creating SDK session");
    const { session } = await createAgentSession({ cwd, agentDir: input.dataDir, modelRuntime,
      model: modelRuntime.getModel("piko", input.model), thinkingLevel: coding ? "medium" : "off",
      noTools: "builtin", customTools: [...customTools, ...appTools],
      ...(input.unified ? { tools: [...appNames, "piko_select_workspace", ...systemNames] } : {}),
      settingsManager, resourceLoader, sessionManager: manager });

    return new AgentSession(session);
  };
}
