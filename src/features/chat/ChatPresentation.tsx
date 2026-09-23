import { Coffee, FileText, MessageCircle } from "lucide-react";
import { isValidElement, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ChatHistoryEntry } from "../../types/appTypes";
import { PetSprite } from "../app/appShared";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

export function extractMarkdownText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractMarkdownText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractMarkdownText(node.props.children);
  return "";
}

export function textForSpeech(text: string) {
  return text
    // Why: 朗读前剥掉 emoji。字符类里确实包含 ZWJ / 变体选择符等组合序列，
    // 这是有意的（要逐个码点剔除），不是漏写 u 标志导致的误解，故关闭该规则。
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F\u20E3]/gu, "");
}

export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children: linkText, href }) => {
          const isSafe = Boolean(href && /^https?:\/\//i.test(href));
          return (
            <a
              href={isSafe ? href : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (isSafe && href) void openUrl(href);
              }}
              rel="noreferrer"
            >
              {linkText}
            </a>
          );
        },
        img: ({ alt, src }) => <img className="markdown-image" alt={alt ?? ""} src={src} />,
        pre: ({ children: code }) => (
          <div className="markdown-code-block">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(extractMarkdownText(code).replace(/\n$/, ""))}
            >
              复制代码
            </button>
            <pre>{code}</pre>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\n+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// --- Sub-components ---

export function InlineToolbar({
  message,
  isSpeaking,
  copyFeedback,
  htmlPreviewEnabled,
  onCopy,
  onSpeech,
  onSave,
  onUpdateHtmlPreview,
  onClearContext,
  onOpenPanel,
}: {
  message: string;
  isSpeaking: boolean;
  copyFeedback: boolean;
  htmlPreviewEnabled: boolean;
  onCopy: () => void;
  onSpeech: () => void;
  onSave: () => void;
  onUpdateHtmlPreview: (enabled: boolean) => void;
  onClearContext: () => void;
  onOpenPanel: () => void;
}) {
  if (!message.trim()) return null;
  return (
    <div className="inline-toolbar">
      <button
        type="button"
        className={`inline-toolbar__btn${copyFeedback ? " inline-toolbar__btn--feedback" : ""}`}
        onClick={onCopy}
        title="复制结果"
      >
        {copyFeedback ? "✓" : "📋"}
      </button>
      <button
        type="button"
        className={`inline-toolbar__btn${isSpeaking ? " inline-toolbar__btn--active" : ""}`}
        onClick={onSpeech}
        title={isSpeaking ? "停止朗读" : "朗读回复"}
      >
        {isSpeaking ? "🔊⏹" : "🔊"}
      </button>
      <button type="button" className="inline-toolbar__btn" onClick={onSave} title="保存回复">
        💾
      </button>
      <details className="inline-more-menu" data-no-drag>
        <summary className="inline-toolbar__btn" title="更多">⋯</summary>
        <div>
          <button
            type="button"
            className={htmlPreviewEnabled ? "is-active" : ""}
            onClick={() => onUpdateHtmlPreview(!htmlPreviewEnabled)}
          >
            HTML 预览
          </button>
          <button type="button" onClick={onClearContext}>
            清空上下文
          </button>
          <button type="button" onClick={onOpenPanel}>
            打开面板
          </button>
        </div>
      </details>
    </div>
  );
}

export function HistoryItem({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ChatHistoryEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`bubble-thread__history-item${isExpanded ? " bubble-thread__history-item--expanded" : ""}`}>
      <button type="button" className="bubble-thread__history-toggle" onClick={onToggle}>
        <span className="bubble-thread__history-arrow">{isExpanded ? "▾" : "▸"}</span>
        <span className="bubble-thread__history-prompt">{truncate(entry.prompt, 30)}</span>
        <span className="bubble-thread__history-time">{formatTime(entry.createdAt)}</span>
      </button>
      {isExpanded ? (
        <div className="bubble-thread__history-body">
          <div className="bubble-thread__user-bubble bubble-thread__user-bubble--history">
            {entry.prompt}
          </div>
          <div className="bubble-thread__ai-card bubble-thread__ai-card--history">
            <div className="bubble-thread__ai-sprite">
              <PetSprite mode="idle" compact />
            </div>
            <div className="bubble-thread__ai-content">
              <MarkdownContent>{entry.response}</MarkdownContent>
            </div>
          </div>
          <div className="inline-toolbar">
            <button
              type="button"
              className="inline-toolbar__btn"
              onClick={() => void navigator.clipboard.writeText(entry.response)}
              title="复制"
            >
              📋
            </button>
            <button
              type="button"
              className="inline-toolbar__btn"
              onClick={() => {
                if (!("speechSynthesis" in window)) return;
                const spoken = textForSpeech(entry.response).trim();
                if (!spoken) return;
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(spoken);
                utterance.lang = "zh-CN";
                window.speechSynthesis.speak(utterance);
              }}
              title="朗读"
            >
              🔊
            </button>
          </div>
        </div>
      ) : (
        <p className="bubble-thread__history-response">
          ↳ {truncate(entry.response, 40)}
        </p>
      )}
    </div>
  );
}

export function WelcomeState({ companionName, message, onSuggest }: { companionName: string; message: string; onSuggest: (prompt: string) => void }) {
  return (
    <div className="bubble-welcome">
      <PetSprite mode="idle" />
      <p className="bubble-welcome__greeting">
        {message || `你好，我是 ${companionName}。今天想一起完成什么？`}
      </p>
      <div className="bubble-suggestions" aria-label="提问建议">
        <button type="button" onClick={() => onSuggest("帮我梳理一下今天的计划")}><Coffee size={14} />安排今天</button>
        <button type="button" onClick={() => onSuggest("帮我整理这段文字的重点：")}><FileText size={14} />整理想法</button>
        <button type="button" onClick={() => onSuggest("陪我聊一会儿吧")}><MessageCircle size={14} />随便聊聊</button>
      </div>
    </div>
  );
}

