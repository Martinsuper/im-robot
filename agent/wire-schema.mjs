// Generated from Rust agent_protocol.rs; do not edit.
export const PROTOCOL_VERSION = 1;
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
  "delta": [
    "text"
  ],
  "failed": [
    "message"
  ],
  "protocol-error": [
    "message"
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
  ]
};
