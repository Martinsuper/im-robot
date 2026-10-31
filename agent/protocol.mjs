/** Private Rust ↔ Node protocol. Unversioned commands remain supported for CLI clients. */
import { PROTOCOL_VERSION, EVENT_FIELDS } from "./wire-schema.mjs";
export { PROTOCOL_VERSION };
const commands = new Set(["start", "steer", "approval", "app-result", "cancel", "contract"]);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function parseCommand(line, activeRequestId) {
  const input = JSON.parse(line);
  if (!input || typeof input !== "object" || Array.isArray(input) || !commands.has(input.type)) {
    throw new Error("未知的 Agent 指令");
  }
  if (input.protocolVersion !== undefined && input.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Agent 通信协议版本不兼容");
  }
  if (input.requestId !== undefined && !nonempty(input.requestId)) throw new Error("无效的任务标识");
  if (input.type !== "start" && input.requestId !== undefined && input.requestId !== activeRequestId) {
    throw new Error("Agent 指令不属于当前任务");
  }
  if (input.type === "start") {
    for (const field of ["cwd", "dataDir", "conversationId", "provider", "model", "baseUrl", "prompt"]) {
      if (!nonempty(input[field])) throw new Error(`Agent 指令缺少 ${field}`);
    }
  } else if (input.type === "steer" && !nonempty(input.text)) {
    throw new Error("补充要求不能为空");
  } else if (input.type === "approval" && (!nonempty(input.approvalId) || typeof input.allowed !== "boolean")) {
    throw new Error("无效的操作确认");
  } else if (input.type === "app-result" && !nonempty(input.callId)) {
    throw new Error("无效的工具调用标识");
  } else if (input.type === "contract" && !nonempty(input.contractId)) {
    throw new Error("无效的任务契约");
  }
  return input;
}

export function eventEnvelope(event, requestId) {
  const required=EVENT_FIELDS[event.type];
  if (!required || required.some(field=>typeof event[field]!=="string")) throw new Error("Agent 事件不符合通信契约");
  return { ...event, protocolVersion: PROTOCOL_VERSION, ...(requestId ? { requestId } : {}) };
}
