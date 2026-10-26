import { LoaderCircle, Trash2, X } from "lucide-react";

export function ConversationDeleteButton({ id, title, armed, busy, disabled, onClick }: {
  id: string; title: string; armed: boolean; busy: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" data-conversation-delete={id}
    className={`conversation-tabs__close${armed ? " conversation-tabs__close--confirm" : ""}`}
    aria-label={`${armed ? "确认删除" : "删除"}会话：${title}`}
    title={armed ? "再次点击将永久删除会话" : "删除会话"}
    aria-busy={armed && busy}
    disabled={disabled || busy} onClick={onClick}>
    {armed ? (busy ? <LoaderCircle size={14} className="conversation-tabs__delete-spinner" /> : <Trash2 size={14} />) : <X size={12} />}
  </button>;
}
