import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { deviceConversations, type RecentConversation } from "./deviceConversations";
import { toTaskRecords } from "./taskOutcomeModel";

import { ConversationDeleteButton } from "./ConversationDeleteButton";

const PAGE_SIZE = 20;
export function DeviceConversationHistory({ openIds, onOpen, onDelete, deleteTargetId, deleting }: { deleteTargetId?: string; deleting: boolean; openIds: string[]; onOpen: (conversation: RecentConversation) => void; onDelete: (conversation: RecentConversation) => void }) {
  const [history, setHistory] = useState<RecentConversation[]>([]);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    let generation = 0;
    const live = new Map<string, RecentConversation>();
    const load = async () => {
      const current = ++generation;
      try {
        const [entries, records] = await Promise.all([
          runCommand("list_chat_history"),
          // Failed tasks may have no saved answer. Their optional metadata must not hide saved chats.
          runCommand("agent_list_tasks").then(toTaskRecords).catch(() => []),
        ]);
        if (!disposed && current === generation) {
          setHistory([...live.values(), ...deviceConversations(records, entries).filter(item => !live.has(item.id))]);
          setError("");
        }
      } catch (cause) {
        if (!disposed && current === generation) setError(toUserMessage(cause, "设备对话加载失败，请重试。"));
      }
    };
    const subscriptions = [
      listen("chat-history-updated", () => void load()),
      listen<{ type: string; conversationId?: string; prompt?: string }>("agent-event", ({ payload: event }) => {
        if (disposed || !event.conversationId?.startsWith("passport-")) return;
        if (event.type === "started") {
          const conversation = { id: event.conversationId, title: event.prompt?.slice(0, 24) || "设备对话" };
          live.set(conversation.id, conversation);
          setHistory(value => [conversation, ...value.filter(item => item.id !== conversation.id)]);
        } else if (["completed", "failed", "cancelled"].includes(event.type)) {
          live.delete(event.conversationId);
          void load();
        }
      }),
    ];
    void Promise.all(subscriptions).then(() => { if (!disposed) void load(); }).catch(cause => {
      if (!disposed) setError(toUserMessage(cause, "设备对话加载失败，请重试。"));
    });
    return () => { disposed = true; for (const subscription of subscriptions) void subscription.then(dispose => dispose()).catch(() => {}); };
  }, [reload]);
  const closed = history.filter(conversation => !openIds.includes(conversation.id));
  if (!closed.length && !error) return null;
  return <section className="conversation-tabs__history" aria-label="设备对话历史">
    {error && <p role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>重试</button></p>}
    {closed.slice(0, limit).map(conversation => <div className="conversation-tabs__item" key={conversation.id}>
      <button type="button" title={conversation.title} onClick={() => onOpen(conversation)}><span className="conversation-tabs__title">{conversation.title}</span></button>
      <ConversationDeleteButton id={conversation.id} title={conversation.title} armed={deleteTargetId === conversation.id}
        busy={deleting} onClick={() => onDelete(conversation)} />
    </div>)}
    {closed.length > limit && <button type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>显示更多对话</button>}
  </section>;
}
