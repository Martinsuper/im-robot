/* eslint-disable react-refresh/only-export-components -- preview parsing helpers are intentionally colocated with the renderer */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Code, Copy, Check, ExternalLink, Eye, Star } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";

function isFullHtmlDocument(source: string) {
  const trimmed = source.trimStart();
  return /^<!doctype html\b/i.test(trimmed) || /^<html\b/i.test(trimmed);
}

export function extractHtmlPreviewSource(message: string) {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const fencedBlockMatch = trimmed.match(/```html\s*([\s\S]*?)\s*```/i);
  if (fencedBlockMatch) {
    return fencedBlockMatch[1].trim() || null;
  }

  const htmlStartIndex = trimmed.search(/<!doctype html\b/i);
  if (htmlStartIndex >= 0) {
    return trimmed.slice(htmlStartIndex).trim();
  }

  const htmlTagIndex = trimmed.search(/<html\b/i);
  if (htmlTagIndex >= 0) {
    return trimmed.slice(htmlTagIndex).trim();
  }

  return null;
}

function wrapHtmlFragment(source: string) {
  if (isFullHtmlDocument(source)) return source;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color: #263449;
        background: #f7f8f5;
        font-family: Inter, ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif;
      }
      html, body {
        margin: 0;
        min-height: 100%;
        overflow: auto;
      }
      body {
        box-sizing: border-box;
        padding: 12px;
      }
    </style>
  </head>
  <body>
    ${source}
  </body>
</html>`;
}

/// The backend serves preview frames over its own `preview` protocol so the
/// strict main-window CSP (script-src 'self') does not apply to previewed content.
export function previewFrameUrl(token: string) {
  const isMac = navigator.userAgent.includes("Mac");
  return isMac ? `preview://localhost/frame/${token}` : `http://preview.localhost/frame/${token}`;
}

export type HtmlPreviewView = "preview" | "source";

export function HtmlPreviewFrame({
  source,
  sourceChatId,
  view: controlledView,
  initialView = "preview",
  onViewChange,
  isFavorited = false,
  onToggleFavorite,
  onEscape,
}: {
  source: string;
  sourceChatId?: string;
  view?: HtmlPreviewView;
  initialView?: HtmlPreviewView;
  onViewChange?: (view: HtmlPreviewView) => void;
  isFavorited?: boolean;
  onToggleFavorite?: () => void;
  onEscape?: () => void;
}) {
  const { t } = useTranslation();
  const escapeChannel = useId();
  const supportsEscape = Boolean(onEscape);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewToken = useRef<string | null>(null);
  const visibilityRatio = useRef(0);
  const [networkSource, setNetworkSource] = useState<string | null>(null);
  const networkAllowed = networkSource === source;
  const setNetworkAllowed = (allowed: boolean) => setNetworkSource(allowed ? source : null);
  const srcDoc = useMemo(() => {
    let html = wrapHtmlFragment(source);
    if (!isTauriRuntime && !networkAllowed) {
      const document = new DOMParser().parseFromString(html, "text/html");
      document.querySelectorAll('meta[http-equiv="refresh" i]').forEach((node) => node.remove());
      document.querySelectorAll('a[href], area[href]').forEach((node) => node.removeAttribute("href"));
      html = document.documentElement.outerHTML;
    }
    if (!isTauriRuntime) {
      const network = networkAllowed ? " https:" : "";
      const policy = `default-src 'none'; script-src 'unsafe-inline'${network}; style-src 'unsafe-inline'${network}; img-src data: blob:${network}; font-src data:${network}; connect-src ${networkAllowed ? "https:" : "'none'"}; frame-src 'none'; form-action 'none'; base-uri 'none'`;
      html = `<meta http-equiv="Content-Security-Policy" content="${policy}">` + html;
    }
    if (!supportsEscape) return html;
    // The opaque sandbox cannot share DOM keyboard events with its parent.
    const bridge = `<script>document.addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();e.stopPropagation();parent.postMessage({type:"piko-preview-escape",channel:${JSON.stringify(escapeChannel)}},"*");}},true);</script>`;
    return html + bridge;
  }, [source, supportsEscape, escapeChannel, networkAllowed]);
  useEffect(() => {
    if (!onEscape) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source === iframeRef.current?.contentWindow && event.data?.type === "piko-preview-escape" && event.data?.channel === escapeChannel) onEscape();
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onEscape, escapeChannel]);
  const [uncontrolledView, setUncontrolledView] = useState<HtmlPreviewView>(initialView);
  const view = controlledView ?? uncontrolledView;
  const [copied, setCopied] = useState(false);
  function setView(next: HtmlPreviewView) {
    if (!controlledView) setUncontrolledView(next);
    onViewChange?.(next);
  }
  const [frameState, setFrameState] = useState<{ source: string; url: string | null; failed: boolean } | null>(null);
  const frameKey = `${networkAllowed ? "online" : "offline"}:${srcDoc}`;
  const currentFrame = frameState?.source === frameKey ? frameState : null;
  const frameUrl = currentFrame?.url ?? null;
  const failed = currentFrame?.failed ?? false;
  useEffect(()=>{
    visibilityRatio.current=0;
    const frame=iframeRef.current;
    if (!frame || typeof IntersectionObserver==="undefined") return;
    const observer=new IntersectionObserver(entries=>{visibilityRatio.current=entries[0]?.intersectionRatio??0;},{threshold:[0,0.5,1]});
    observer.observe(frame);return ()=>observer.disconnect();
  },[frameUrl]);

  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const report = () => {
      const token=previewToken.current;
      if (!token) return;
      const visible=document.visibilityState==="visible" && visibilityRatio.current>=0.5;
      void invoke("soul_preview_visibility",{id:token,visible}).catch(()=>undefined);
    };
    const timer=window.setInterval(report,5000);
    document.addEventListener("visibilitychange",report);
    return ()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",report);if(previewToken.current)void invoke("soul_preview_visibility",{id:previewToken.current,visible:false}).catch(()=>undefined);};
  }, [source]);

  async function openDetached(position?: { x: number; y: number }) {
    if (opening) return;
    setOpening(true);
    setOpenFailed(false);
    try {
      if (isTauriRuntime) {
        await invoke("open_html_preview_window", { html: srcDoc,
          ...(sourceChatId ? {sourceChatId} : {}), ...(networkAllowed ? { allowNetwork: true } : {}), ...position });
      } else {
        const popup = window.open("", "_blank", "popup,width=1000,height=720,resizable=yes,scrollbars=yes");
        if (!popup) throw new Error("Popup blocked");
        popup.opener = null;
        popup.document.title = t("chat.preview.frameTitle", "Piko HTML 预览");
        popup.document.body.style.cssText = "margin:0;height:100vh;overflow:hidden";
        const iframe = popup.document.createElement("iframe");
        iframe.setAttribute("sandbox", isTauriRuntime || networkAllowed ? "allow-scripts" : "");
        iframe.setAttribute("referrerpolicy", "no-referrer");
        iframe.title = popup.document.title;
        iframe.style.cssText = "display:block;border:0;width:100%;height:100%";
        iframe.srcdoc = srcDoc;
        popup.document.body.replaceChildren(iframe);
      }
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    let token: string | null = null;
    (async () => {
      try {
        token = await invoke<string>("create_html_preview_frame", { html: srcDoc,
          ...(sourceChatId ? {sourceChatId} : {}), ...(networkAllowed ? { allowNetwork: true } : {}) });
      } catch {
        if (!disposed) setFrameState({ source: frameKey, url: null, failed: true });
        return;
      }
      if (disposed) {
        void invoke("remove_html_preview_frame", { token }).catch(() => undefined);
        return;
      }
      previewToken.current = token;
      setFrameState({ source: frameKey, url: previewFrameUrl(token), failed: false });
    })().catch(() => undefined);
    return () => {
      disposed = true;
      if (token) {
        void invoke("remove_html_preview_frame", { token }).catch(() => undefined);
      }
    };
  }, [srcDoc, networkAllowed, frameKey, sourceChatId]);

  return (
    <section className="html-preview-card" aria-label={t("chat.preview.ariaLabel", "HTML 预览")}>
      <label className="html-preview-network"><input type="checkbox" checked={networkAllowed} onChange={(event) => setNetworkAllowed(event.target.checked)} />允许此预览联网（可发送页面中的数据）</label>
      <div
        className="html-preview-card__header"
        data-no-drag
        title={t("chat.preview.dragHint", "拖动标题到预览区域外，可在独立窗口打开")}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          dragStart.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => { dragStart.current = null; }}
        onPointerUp={(event) => {
          const start = dragStart.current;
          dragStart.current = null;
          if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 24) return;
          const rect = event.currentTarget.parentElement!.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            void openDetached({ x: event.screenX - 40, y: event.screenY - 20 });
          }
        }}
      >
        <span>{t("chat.preview.title", "HTML 预览")}</span>
        <span className="html-preview-card__actions">
          <span className="html-preview-card__segment" role="tablist" aria-label={t("chat.preview.viewToggle", "预览 / 源码切换")}>
            <button
              type="button"
              role="tab"
              aria-selected={view === "preview"}
              className={view === "preview" ? "is-active" : ""}
              onClick={() => setView("preview")}
              title={t("chat.preview.showPreview", "返回预览")}
            >
              <Eye size={13} />
              {t("chat.preview.previewTab", "预览")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "source"}
              className={view === "source" ? "is-active" : ""}
              onClick={() => setView("source")}
              title={t("chat.preview.showSource", "查看源码")}
            >
              <Code size={13} />
              {t("chat.preview.sourceTab", "源码")}
            </button>
          </span>
          {onToggleFavorite ? (
            <button
              type="button"
              className={isFavorited ? "is-active" : ""}
              onClick={onToggleFavorite}
              title={isFavorited ? t("chat.preview.unfavorite", "取消收藏") : t("chat.preview.favorite", "收藏")}
              aria-label={isFavorited ? t("chat.preview.unfavorite", "取消收藏") : t("chat.preview.favorite", "收藏")}
              aria-pressed={isFavorited}
            >
              <Star size={14} fill={isFavorited ? "currentColor" : "none"} />
            </button>
          ) : null}
          <span>{t("chat.preview.sandboxNote", "沙箱 iframe")}</span>
          <button type="button" disabled={opening} onClick={() => void openDetached()} title={t("chat.preview.openWindow", "独立窗口打开")} aria-label={t("chat.preview.openWindow", "独立窗口打开")}>
            <ExternalLink size={14} />
          </button>
        </span>
      </div>
      {openFailed && <p role="alert">{t("chat.preview.openFailed", "独立窗口打开失败，请重试或允许弹出窗口。")}</p>}
      {failed && <p role="alert">{t("chat.preview.loadFailed", "HTML 预览加载失败，请重试或重启应用。")}</p>}
      {view === "source" ? (
        <div className="html-preview-source">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(source).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
            title={t("chat.preview.copySource", "复制源码")}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {t("chat.preview.copySource", "复制源码")}
          </button>
          <pre><code>{source}</code></pre>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
        className="html-preview-frame"
          sandbox={isTauriRuntime || networkAllowed ? "allow-scripts" : ""}
          srcDoc={isTauriRuntime ? undefined : srcDoc}
          src={isTauriRuntime && frameUrl ? frameUrl : undefined}
          title={t("chat.preview.frameTitle", "Piko HTML 预览")}
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

/** The native window owns its frame token; closing the window removes it in Rust. */
export function HtmlPreviewWindow() {
  const { t } = useTranslation();
  const token = new URLSearchParams(window.location.search).get("token");
  useEffect(()=>{
    if (!isTauriRuntime || !token) return;
    const report=()=>void invoke("soul_preview_visibility",{id:token,visible:document.visibilityState==="visible"}).catch(()=>undefined);
    report();const timer=window.setInterval(report,5000);document.addEventListener("visibilitychange",report);
    return ()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",report);void invoke("soul_preview_visibility",{id:token,visible:false}).catch(()=>undefined);};
  },[token]);

  return (
    <main className="html-preview-window">
      {token ? <iframe
        className="html-preview-window__frame"
        sandbox="allow-scripts"
        src={previewFrameUrl(token)}
        title={t("chat.preview.frameTitle", "Piko HTML 预览")}
        referrerPolicy="no-referrer"
      /> : <p role="alert">{t("chat.preview.loadFailed", "HTML 预览加载失败，请重试或重启应用。")}</p>}
    </main>
  );
}
