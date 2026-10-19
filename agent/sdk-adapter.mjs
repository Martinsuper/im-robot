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
export function fileTools(cwd, {readOnly=false,resuming=false}={}) {
  const factories=readOnly?[createReadToolDefinition]:[createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,...(resuming?[]:[process.platform==="win32"?createPowerShellToolDefinition:createBashToolDefinition])];
  return factories.map(factory=>factory(cwd));
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
export async function prepareAgent(input) {
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
    console.error("[piko] loading resources");
    await resourceLoader.reload();
    console.error("[piko] resources loaded");
    console.error("[piko] creating SDK session");
    const { session } = await createAgentSession({ cwd, agentDir: input.dataDir, modelRuntime,
      model: modelRuntime.getModel("piko", input.model), thinkingLevel: "off",
      noTools: "builtin", customTools: [...customTools, ...appTools],
      ...(input.unified ? { tools: [...appNames, "piko_select_workspace", ...systemNames] } : {}),
      settingsManager, resourceLoader, sessionManager: manager });

    return new AgentSession(session);
  };
}
