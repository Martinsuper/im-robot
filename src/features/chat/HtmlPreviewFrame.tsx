import { useEffect, useMemo, useState } from "react";
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

export function HtmlPreviewFrame({ source }: { source: string }) {
  const { t } = useTranslation();
  const srcDoc = useMemo(() => wrapHtmlFragment(source), [source]);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    let token: string | null = null;
    (async () => {
      try {
        token = await invoke<string>("create_html_preview_frame", { html: srcDoc });
      } catch {
        return;
      }
      if (disposed) {
        void invoke("remove_html_preview_frame", { token }).catch(() => undefined);
        return;
      }
      setFrameUrl(previewFrameUrl(token));
    })().catch(() => undefined);
    return () => {
      disposed = true;
      if (token) {
        void invoke("remove_html_preview_frame", { token }).catch(() => undefined);
      }
    };
  }, [srcDoc]);

  return (
    <section className="html-preview-card" aria-label={t("chat.preview.ariaLabel", "HTML 预览")}>
      <div className="html-preview-card__header">
        <span>{t("chat.preview.title", "HTML 预览")}</span>
        <span>{t("chat.preview.sandboxNote", "沙箱 iframe")}</span>
      </div>
      <iframe
        className="html-preview-frame"
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={isTauriRuntime ? undefined : srcDoc}
        src={isTauriRuntime && frameUrl ? frameUrl : undefined}
        title={t("chat.preview.frameTitle", "Piko HTML 预览")}
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
