import { afterEach, expect, it, vi } from "vitest";
import { CONVERSATION_STORAGE, loadConversation } from "./agentTypes";

afterEach(() => vi.unstubAllGlobals());
function storage(values: Record<string, string>) { vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] || null }); }
it("starts ordinary conversation without requiring a directory or allocating an ID", () => {
  storage({});
  expect(loadConversation()).toEqual({ id: "", cwd: "", importHistory: true, turnIds: [] });
});
it("migrates the previous task session and workspace", () => {
  storage({ "piko-agent-conversation-v1": JSON.stringify({ id: "legacy-session", cwd: "/workspace" }) });
  expect(loadConversation()).toEqual({ id: "legacy-session", cwd: "/workspace", importHistory: true, turnIds: [] });
});
it("keeps the new conversation instead of reverting to a legacy task", () => {
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "new-session", cwd: "", importHistory: false, turnIds: ["a"] }),
    "piko-agent-conversation-v1": JSON.stringify({ id: "legacy", cwd: "/old" }) });
  expect(loadConversation().id).toBe("new-session");
  expect(loadConversation().importHistory).toBe(false);
});

it("restores the conversation knowledge project across reloads", () => {
  storage({ [CONVERSATION_STORAGE]: JSON.stringify({ id: "piko-chat", cwd: "", knowledgeScope: "piko", turnIds: ["r1"] }) });
  expect(loadConversation().knowledgeScope).toBe("piko");
  expect(loadConversation().turnIds).toEqual(["r1"]);
});
