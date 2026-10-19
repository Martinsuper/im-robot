import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { AlertTriangle,Check,ChevronDown,ChevronRight,Copy,Download,MessageCircle,MoreHorizontal,RotateCcw,Settings2,Square,Volume2 } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatHistoryEntry } from "../../types/appTypes";
import { PetSprite } from "../app/appShared";
import { extractMarkdownText,formatTime,SUGGESTION_ICONS,textForSpeech,truncate } from "./ChatPresentationData";
import { suggestionsFor } from "./chatSuggestions";
import { extractHtmlPreviewSource,HtmlPreviewFrame,type HtmlPreviewView } from "./HtmlPreviewFrame";
import { foldedRemainder,foldReply,shouldFoldReply } from "./replyFolding";
import "./replyStatus.css";


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
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu && !menu.contains(event.target as Node)) menu.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuRef.current?.open) {
        event.preventDefault();
        event.stopPropagation();
        menuRef.current.open = false;
        menuRef.current.querySelector("summary")?.focus();
      }
    };
    const closeOnBlur = () => { if (menuRef.current) menuRef.current.open = false; };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, []);
  if (!message.trim()) return null;
  return (
    <div className="inline-toolbar">
      <button
        type="button"
        className={`inline-toolbar__btn${copyFeedback ? " inline-toolbar__btn--feedback" : ""}`}
        onClick={onCopy}
        title="复制结果"
      >
        {copyFeedback ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <button
        type="button"
        className={`inline-toolbar__btn${isSpeaking ? " inline-toolbar__btn--active" : ""}`}
        onClick={onSpeech}
        title={isSpeaking ? "停止朗读" : "朗读回复"}
      >
        {isSpeaking ? <Square size={14} /> : <Volume2 size={15} />}
      </button>
      <button type="button" className="inline-toolbar__btn" onClick={onSave} title="保存回复">
        <Download size={15} />
      </button>
      <details ref={menuRef} className="inline-more-menu" data-no-drag>
        <summary className="inline-toolbar__btn" title="更多" aria-label="更多操作"><MoreHorizontal size={16} /></summary>
        <div onClick={() => { if (menuRef.current) menuRef.current.open = false; }}>
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
  htmlPreviewEnabled,
  previewAsSource,
  isFavorited,
  onToggle,
  onPreviewViewChange,
  onToggleFavorite,
}: {
  entry: ChatHistoryEntry;
  isExpanded: boolean;
  htmlPreviewEnabled: boolean;
  previewAsSource?: boolean;
  isFavorited?: boolean;
  onToggle: () => void;
  onPreviewViewChange?: (view: HtmlPreviewView) => void;
  onToggleFavorite?: () => void;
}) {
  const rawPreviewSource = extractHtmlPreviewSource(entry.response);
  const htmlPreviewSource = isExpanded && htmlPreviewEnabled && !previewAsSource ? rawPreviewSource : null;
  return (
    <div className={`bubble-thread__history-item${isExpanded ? " bubble-thread__history-item--expanded" : ""}`}>
      <button type="button" className="bubble-thread__history-toggle" onClick={onToggle} aria-expanded={isExpanded}>
        <span className="bubble-thread__history-arrow">{isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
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
            {htmlPreviewSource || (previewAsSource && rawPreviewSource) ? (
              <HtmlPreviewFrame
                sourceChatId={entry.id}
                source={(htmlPreviewSource ?? rawPreviewSource) as string}
                view={htmlPreviewSource ? "preview" : "source"}
                onViewChange={onPreviewViewChange}
                isFavorited={isFavorited}
                onToggleFavorite={onToggleFavorite}
              />
            ) : (
              <div className="bubble-thread__ai-content">
                <MarkdownContent>{rawPreviewSource && !htmlPreviewEnabled ? `\`\`\`html\n${rawPreviewSource}\n\`\`\`` : entry.response}</MarkdownContent>
              </div>
            )}
          </div>
          <div className="inline-toolbar">
            <button
              type="button"
              className="inline-toolbar__btn"
              onClick={() => void navigator.clipboard.writeText(entry.response)}
              title="复制"
            >
              <Copy size={15} />
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
              <Volume2 size={15} />
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
  // 建议随小时变化（02 §11）；点击只填入输入框，不自动发送。
  const suggestions = suggestionsFor();
  return (
    <div className="bubble-welcome">
      <PetSprite mode="idle" />
      <h1 className="bubble-welcome__title">今天想聊点什么？</h1>
      <p className="bubble-welcome__greeting">
        {message || `你好，我是 ${companionName}。随时陪你聊聊，也帮你记下灵感。`}
      </p>
      <div className="bubble-suggestions" aria-label="提问建议">
        {suggestions.map((suggestion, index) => {
          const Icon = SUGGESTION_ICONS[index] ?? MessageCircle;
          return (
            <button key={suggestion.label} type="button" onClick={() => onSuggest(suggestion.prompt)}>
              <Icon size={14} />
              {suggestion.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}


/**
 * 长回复折叠（02 §7.3）。
 *
 * 含代码块时不折叠，改由 `shouldFoldReply` 决定（代码被截断比不折叠更糟）。
 */
export function CollapsibleReply({ markdown }: { markdown: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!shouldFoldReply(markdown)) return <MarkdownContent>{markdown}</MarkdownContent>;
  const remainder = foldedRemainder(markdown);
  return (
    <>
      <MarkdownContent>{expanded ? markdown : foldReply(markdown)}</MarkdownContent>
      <button type="button" className="reply-fold-toggle" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "收起" : `展开全部（还有 ${remainder} 字）`}
      </button>
    </>
  );
}


/**
 * 失败 / 停止状态（02 §4、§12）。
 *
 * 关键要求：**停止后保留已生成内容**，不整段清空；失败必须给出可操作按钮。
 * 文案禁止直出 Rust / HTTP 原始错误——一律经过 `toUserMessage` 之后传进来。
 */
export function ReplyStatusCard({
  tone,
  message,
  onRetry,
  onOpenSettings,
}: {
  tone: "failed" | "cancelled";
  message?: string;
  onRetry: () => void;
  onOpenSettings?: () => void;
}) {
  if (tone === "cancelled") {
    return (
      <div className="reply-status reply-status--cancelled" role="status">
        <Square size={14} aria-hidden="true" />
        <span>已停止</span>
        <button type="button" className="text-action" onClick={onRetry}>编辑后再发送</button>
      </div>
    );
  }
  return (
    <div className="reply-status reply-status--failed" role="alert">
      <AlertTriangle size={15} aria-hidden="true" />
      <div className="reply-status__body">
        <p>{message || "出了点小状况"}</p>
        <div className="reply-status__actions">
          <button type="button" onClick={onRetry}><RotateCcw size={13} />编辑后再发送</button>
          {onOpenSettings ? (
            <button type="button" className="text-action" onClick={onOpenSettings}>
              <Settings2 size={13} />检查设置
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}


/**
 * 未配置模型时的引导卡（02 §10.4）。
 *
 * 「未配置也能打开对话」是硬要求：不能因为没配 Key 就让窗口打不开或者一片空白。
 */
export function ModelSetupCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="model-setup-card" role="status">
      <p className="model-setup-card__title">先连接一个 AI 才能聊天</p>
      <p className="model-setup-card__hint">
        连上之后就能直接问我问题；也可以用本机运行的模型，不需要 Key。
      </p>
      <button type="button" className="primary-action" onClick={onOpenSettings}>
        <Settings2 size={14} />去设置
      </button>
    </div>
  );
}
