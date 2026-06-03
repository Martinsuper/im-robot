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

export function HtmlPreviewFrame({ source }: { source: string }) {
  const srcDoc = wrapHtmlFragment(source);

  return (
    <section className="html-preview-card" aria-label="HTML 预览">
      <div className="html-preview-card__header">
        <span>HTML 预览</span>
        <span>沙箱 iframe</span>
      </div>
      <iframe
        className="html-preview-frame"
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={srcDoc}
        title="Piko HTML 预览"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
