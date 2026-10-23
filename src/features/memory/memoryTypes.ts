import type {
  T_memory_model_BuildContextInput_Input,
  T_memory_model_CreateMemoryInput_Input,
  T_memory_model_FeedbackInput_Input,
  T_memory_model_ListMemoriesInput_Input,
  T_memory_model_MemoryCandidate_Output,
  T_memory_model_MemoryExport_Output,
  T_memory_model_MemoryItem_Output,
  T_memory_model_MemoryRelation_Output,
  T_memory_model_MemorySource_Output,
  T_memory_model_MemoryStatus_Output,
  T_memory_model_MemoryType_Output,
  T_memory_model_PrivacyLevel_Output,
  T_memory_model_ReflectionSummary_Output,
  T_memory_model_SearchMemoriesInput_Input,
  T_memory_model_SearchRelatedInput_Input,
  T_memory_model_UpdateMemoryInput_Input,
} from "../../generated/ipc";

export type MemoryType = T_memory_model_MemoryType_Output;
export type MemorySource = T_memory_model_MemorySource_Output;
export type PrivacyLevel = T_memory_model_PrivacyLevel_Output;
export type MemoryStatus = T_memory_model_MemoryStatus_Output;

export type MemoryItem = T_memory_model_MemoryItem_Output;
export type CreateMemoryInput = T_memory_model_CreateMemoryInput_Input;
export type UpdateMemoryInput = T_memory_model_UpdateMemoryInput_Input;
export type ListMemoriesInput = T_memory_model_ListMemoriesInput_Input;
export type SearchMemoriesInput = T_memory_model_SearchMemoriesInput_Input;
export type SearchRelatedInput = T_memory_model_SearchRelatedInput_Input;
export type BuildContextInput = T_memory_model_BuildContextInput_Input;
export type FeedbackInput = T_memory_model_FeedbackInput_Input;
export type MemoryRelation = T_memory_model_MemoryRelation_Output;
export type MemoryCandidate = T_memory_model_MemoryCandidate_Output;
export type ReflectionSummary = T_memory_model_ReflectionSummary_Output;
export type MemoryExport = T_memory_model_MemoryExport_Output;

export interface MergeCandidate {
  keep: MemoryItem;
  remove: MemoryItem;
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
  { label: "项目知识", value: "semantic" },
  { label: "操作记录", value: "operational" },
  { label: "系统反思", value: "reflection" },
];

export const FEEDBACK_TYPES: Array<{ label: string; value: string; valueNum: number }> = [
  { label: "👍 有用", value: "useful", valueNum: 1 },
  { label: "👎 没用", value: "useless", valueNum: -1 },
  { label: "✅ 正确", value: "correct", valueNum: 1 },
  { label: "❌ 错误", value: "incorrect", valueNum: -1 },
];

export const RELATION_LABELS: Record<string, string> = {
  duplicatesOf: "重复",
  derivedFrom: "派生自",
  conflictsWith: "冲突",
  supersedes: "取代",
  relatedTo: "相关",
};
