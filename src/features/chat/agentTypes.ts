import type { ActionDraft } from "./chatTypes";

export type AgentEvent = {
  requestId: string;
  eventSequence?: number;
  conversationId?: string;
  knowledgeScope?: string | null;
  prompt?: string;
  response?: string;
  type: "started" | "delta" | "tool-start" | "tool-end" | "approval" | "approval-expired" | "action-proposed" | "workspace-required" | "completed" | "cancelled" | "failed" | "protocol-error" | "steering-accepted" | "approval-resolved" | "action-resolved" | "workspace-resolved";
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
};
export type ToolActivity = { id: string; name: string; arguments: Record<string, unknown>; status: string; output?: string; verification?: { state: string; kind?: string; reused?: boolean } };
export type ToolApproval = { id: string; tool: string; arguments: Record<string, unknown> };
export type Conversation = { id: string; cwd: string; knowledgeScope?: string; importHistory: boolean; turnIds: string[] };
export const CONVERSATION_STORAGE = "piko-unified-conversation-v1";
export function loadConversation(): Conversation {
  try {
    const value = JSON.parse(localStorage.getItem(CONVERSATION_STORAGE) || "null");
    if (typeof value?.id === "string" && typeof value.cwd === "string") {
      return { id: value.id, cwd: value.cwd, knowledgeScope: typeof value.knowledgeScope === "string" ? value.knowledgeScope : undefined, importHistory: value.importHistory === true, turnIds: Array.isArray(value.turnIds) ? value.turnIds.filter((id: unknown) => typeof id === "string") : [] };
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
