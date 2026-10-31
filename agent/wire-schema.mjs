// Generated from Rust agent_protocol.rs; do not edit.
export const PROTOCOL_VERSION = 2;
export const EVENT_FIELDS = {
  "app-tool": [
    "callId",
    "name"
  ],
  "approval": [
    "approvalId",
    "tool"
  ],
  "approval-expired": [
    "approvalId"
  ],
  "cancelled": [],
  "completed": [],
  "contract-proposed": [
    "contractId"
  ],
  "delta": [
    "text"
  ],
  "failed": [
    "message"
  ],
  "milestone": [
    "milestoneId",
    "status"
  ],
  "notice": [
    "level",
    "text"
  ],
  "protocol-error": [
    "message"
  ],
  "receipt": [
    "status"
  ],
  "started": [],
  "steering-accepted": [
    "text"
  ],
  "tool-end": [
    "tool",
    "toolCallId"
  ],
  "tool-start": [
    "tool",
    "toolCallId"
  ],
  "usage": []
};
