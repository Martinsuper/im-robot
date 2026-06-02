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
  isPinned: boolean;
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

export interface SearchMemoriesInput {
  query: string;
  memoryType?: MemoryType;
  limit?: number;
}

export interface SearchRelatedInput {
  query: string;
  contextTags?: string[];
  limit?: number;
}

export interface BuildContextInput {
  currentQuery?: string;
  windowType?: string;
  limit?: number;
}

export interface FeedbackInput {
  memoryId: string;
  feedbackType: string;
  value: number;
  comment?: string;
}

export interface MemoryRelation {
  fromId: string;
  toId: string;
  relationType: string;
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

export const FEEDBACK_TYPES: Array<{ label: string; value: string; valueNum: number }> = [
  { label: "👍 有用", value: "useful", valueNum: 1 },
  { label: "👎 没用", value: "useless", valueNum: -1 },
  { label: "✅ 正确", value: "correct", valueNum: 1 },
  { label: "❌ 错误", value: "incorrect", valueNum: -1 },
];

// === Phase 3+ types ===

export interface MemoryCandidate {
  id: string;
  title: string;
  content: string;
  memoryType: MemoryType;
  source: MemorySource;
  confidence: number;
  importance: number;
  tags: string[];
  requiresConfirmation: boolean;
}

export interface ReflectionSummary {
  id: string;
  summaryType: string;
  content: string;
  createdAt: number;
  periodStart?: number;
  periodEnd?: number;
}

export interface MemoryExport {
  version: string;
  exportedAt: number;
  memories: MemoryItem[];
  relations: MemoryRelation[];
}

export interface MergeCandidate {
  keep: MemoryItem;
  remove: MemoryItem;
}

export const RELATION_LABELS: Record<string, string> = {
  duplicatesOf: "重复",
  derivedFrom: "派生自",
  conflictsWith: "冲突",
  supersedes: "取代",
  relatedTo: "相关",
};
