export interface ActionDraft {
  id: string;
  pluginId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
  createdAt: number;
}

export interface ActionExecution {
  message: string;
  result: unknown;
  followUpPrompt: string;
}

export type ChatEvent =
  | { type: "started"; requestId: string; working: boolean }
  | { type: "delta"; requestId: string; sequence: number; text: string }
  | { type: "completed"; requestId: string }
  | { type: "action-proposed"; requestId: string; draft: ActionDraft }
  | { type: "cancelled"; requestId: string }
  | { type: "failed"; requestId: string; message: string };

export interface MemoryCapturedEvent {
  confirmed: number;
  pending: number;
}
