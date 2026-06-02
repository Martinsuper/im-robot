export type MemoryType = "profile" | "event" | "semantic" | "operational" | "reflection";
export type MemorySource = "userExplicit" | "conversation" | "toolResult" | "taskOutcome" | "systemReflection";
export type PrivacyLevel = "publicToUser" | "sensitiveLocalOnly" | "ephemeral";
export type MemoryStatus = "active" | "archived" | "superseded" | "deleted";

export interface MemoryItem {
  id: string;
  memoryType: MemoryType;
  title: string;
  content: string;
  source: MemorySource;
  importance: number;
  confidence: number;
  recencyScore: number;
  privacyLevel: PrivacyLevel;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  tags: string[];
  embeddingId?: string;
}

export interface CreateMemoryInput {
  memoryType: MemoryType;
  title: string;
  content: string;
  source: MemorySource;
  importance?: number;
  tags?: string[];
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  importance?: number;
  tags?: string[];
}

export interface ListMemoriesInput {
  memoryType?: MemoryType;
  status?: MemoryStatus;
  limit?: number;
}

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  profile: "用户档案",
  event: "事件记忆",
  semantic: "语义知识",
  operational: "操作记录",
  reflection: "系统反思",
};

export const MEMORY_SOURCE_LABELS: Record<MemorySource, string> = {
  userExplicit: "用户明确表达",
  conversation: "对话提取",
  toolResult: "工具结果",
  taskOutcome: "任务结果",
  systemReflection: "系统反思",
};

export const MEMORY_TYPE_OPTIONS: Array<{ label: string; value: MemoryType | "all" }> = [
  { label: "全部", value: "all" },
  { label: "用户档案", value: "profile" },
  { label: "事件记忆", value: "event" },
];
