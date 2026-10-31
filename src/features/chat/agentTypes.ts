import type { ActionDraft } from "./chatTypes";

export type AgentEvent = {
  requestId: string;
  eventSequence?: number;
  conversationId?: string;
  knowledgeScope?: string | null;
  prompt?: string;
  response?: string;
  type: "started" | "delta" | "tool-start" | "tool-end" | "approval" | "approval-expired" | "action-proposed" | "workspace-required" | "completed" | "cancelled" | "failed" | "protocol-error" | "steering-accepted" | "approval-resolved" | "action-resolved" | "workspace-resolved"
    | "contract-proposed" | "milestone" | "notice" | "usage" | "receipt";
  text?: string;
  allowed?: boolean;
  cwd?: string | null;
  tool?: string;
  arguments?: Record<string, unknown>;
  approvalId?: string;
  toolCallId?: string;
  message?: string;
  output?: string;
  isError?: boolean;
  draft?: ActionDraft;
  verification?: { state: string; kind?: string; reused?: boolean };
  // 协议 v2（doc/design/18 §1）：contract-proposed / milestone / notice / receipt 载荷。
  contractId?: string;
  contract?: unknown;
  milestoneId?: string;
  status?: string;
  title?: string;
  note?: string;
  level?: string;
  summary?: string;
  receipt?: unknown;
};
export type ToolActivity = { id: string; name: string; arguments: Record<string, unknown>; status: string; output?: string; verification?: { state: string; kind?: string; reused?: boolean }; milestoneId?: string };

// --- 委托式任务（doc/design/18 §3-§5）---

export type TaskKind = "companion" | "coding";
export type GitMode = "branch" | "files-only" | "off";
export type PolicyAutonomy = "confirm" | "auto";
export type AgentPolicy = { workspaceFiles: PolicyAutonomy; shell: PolicyAutonomy; outsideWorkspace: PolicyAutonomy };
export type PolicyPreset = "cautious" | "standard" | "trusted";
export type SteerMode = "guidance" | "redirect";

export const POLICY_PRESETS: Record<PolicyPreset, AgentPolicy> = {
  cautious: { workspaceFiles: "confirm", shell: "confirm", outsideWorkspace: "confirm" },
  standard: { workspaceFiles: "auto", shell: "confirm", outsideWorkspace: "confirm" },
  trusted: { workspaceFiles: "auto", shell: "auto", outsideWorkspace: "confirm" },
};

export type ContractMilestone = { id: string; title: string; acceptance: string };
export type ContractObject = { goal: string; milestones: ContractMilestone[]; verifyCommand: string; timeMinutes: number; risks: string[] };
export type PendingContract = { contractId: string; contract: ContractObject };

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 事件里的 contract 是任意 JSON；按 doc 18 §3 收敛成可编辑对象。 */
export function parseContract(value: unknown): ContractObject {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const milestones = Array.isArray(source.milestones) ? source.milestones : [];
  const parsed = milestones.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  return {
    goal: asText(source.goal),
    milestones: parsed.map((entry, index) => ({
      id: asText(entry.id) || `m${index + 1}`,
      title: asText(entry.title),
      acceptance: asText(entry.acceptance),
    })),
    verifyCommand: asText(source.verifyCommand),
    timeMinutes: asNumber(source.timeMinutes),
    risks: Array.isArray(source.risks) ? source.risks.map(asText).filter(Boolean) : [],
  };
}

export type MilestoneStatus = "started" | "completed" | "failed" | "skipped";
export type MilestoneProgress = { id: string; status: MilestoneStatus; title?: string; note?: string };

/** milestone 事件按 id 折叠进时间线；未知 status 保持原样交给展示层兜底。 */
export function applyMilestone(current: MilestoneProgress[], event: { milestoneId?: string; status?: string; title?: string; note?: string }): MilestoneProgress[] {
  const id = event.milestoneId || "";
  if (!id) return current;
  const status = ["started", "completed", "failed", "skipped"].includes(event.status || "")
    ? (event.status as MilestoneStatus) : "started";
  const existing = current.findIndex((item) => item.id === id);
  if (existing === -1) {
    return [...current, { id, status, title: event.title || undefined, note: event.note || undefined }];
  }
  const next = [...current];
  const previous = next[existing];
  next[existing] = {
    id,
    status,
    title: event.title || previous.title,
    note: event.note || previous.note,
  };
  return next;
}

export type NoticeEntry = { level: "info" | "warn"; text: string };

export function parseNotice(level: unknown, text: unknown): NoticeEntry | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return { level: level === "warn" ? "warn" : "info", text };
}

export type ReceiptFileChange = { path: string; added: number; removed: number };
export type ReceiptVerify = { command: string; ok: boolean; output?: string };
export type ReceiptObject = {
  milestones: Array<{ id: string; title?: string; status: string; note?: string }>;
  filesChanged: ReceiptFileChange[];
  verify: ReceiptVerify[];
  notices: NoticeEntry[];
  branch?: string;
  commits: string[];
  openQuestions: string[];
};
export type ReceiptRecord = { status: string; summary?: string; receipt: ReceiptObject };

/** 事件里的 receipt 是任意 JSON；按 doc 18 §4 收敛，字段缺失一律给空值。 */
export function parseReceipt(value: unknown): ReceiptObject {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const milestones = Array.isArray(source.milestones) ? source.milestones : [];
  const files = Array.isArray(source.filesChanged) ? source.filesChanged : [];
  const verify = Array.isArray(source.verify) ? source.verify : [];
  const notices = Array.isArray(source.notices) ? source.notices : [];
  return {
    milestones: milestones.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { id: asText(entry.id), title: asText(entry.title) || undefined, status: asText(entry.status) || "unknown", note: asText(entry.note) || undefined };
    }),
    filesChanged: files.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { path: asText(entry.path), added: asNumber(entry.added), removed: asNumber(entry.removed) };
    }).filter((item) => item.path),
    verify: verify.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { command: asText(entry.command), ok: entry.ok === true, output: asText(entry.output) || undefined };
    }),
    notices: notices.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return parseNotice(entry.level, entry.text);
    }).filter((item): item is NoticeEntry => item !== null),
    branch: asText(source.branch) || undefined,
    commits: Array.isArray(source.commits) ? source.commits.map(asText).filter(Boolean) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map(asText).filter(Boolean) : [],
  };
}

/** 协议 v2 start 新增字段（doc 18 §2）；generated 契约更新前经交叉类型透传。 */
export type AgentStartInputV2 = {
  taskKind?: TaskKind;
  policy?: AgentPolicy;
  budget?: { timeMinutes: number; tokenBudget: number };
  projectId?: string;
  verifyCommand?: string;
  gitMode?: GitMode;
};

export type ToolApproval = { id: string; tool: string; arguments: Record<string, unknown> };
export type ProjectInfo = { id: string; name: string; path: string; verifyCommand?: string | null; lastOpenedAt?: number };
export type Conversation = { id: string; cwd: string; knowledgeScope?: string; importHistory: boolean; turnIds: string[]; projectId?: string; projectName?: string };
export const CONVERSATION_STORAGE = "piko-unified-conversation-v1";
export function loadConversation(): Conversation {
  try {
    const value = JSON.parse(localStorage.getItem(CONVERSATION_STORAGE) || "null");
    if (typeof value?.id === "string" && typeof value.cwd === "string") {
      return { id: value.id, cwd: value.cwd, knowledgeScope: typeof value.knowledgeScope === "string" ? value.knowledgeScope : undefined, importHistory: value.importHistory === true,
        projectId: typeof value.projectId === "string" && value.projectId ? value.projectId : undefined,
        projectName: typeof value.projectName === "string" && value.projectName ? value.projectName : undefined,
        turnIds: Array.isArray(value.turnIds) ? value.turnIds.filter((id: unknown) => typeof id === "string") : [] };
    }
  } catch { /* Storage is optional. */ }
  try {
    const legacy = JSON.parse(localStorage.getItem("piko-agent-conversation-v1") || "null");
    if (typeof legacy?.id === "string" && legacy.id && typeof legacy.cwd === "string") {
      return { id: legacy.id, cwd: legacy.cwd, importHistory: true, turnIds: [] };
    }
  } catch { /* Older task sessions are optional. */ }
  return { id: "", cwd: "", importHistory: true, turnIds: [] };
}

/** Rust-owned in-memory projection. Reading it never resumes or replays tools. */
export type AgentTaskSnapshot = {
  requestId: string;
  conversationId: string;
  knowledgeScope?: string | null;
  cwd: string | null;
  prompt: string;
  response: string;
  eventSequence: number;
  events: AgentEvent[];
};
