import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { CaptureSelection } from "../../types/appTypes";
import { normalizeCaptureSelection } from "../app/appShared";
import { runCommand, runCommandQuiet } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";

export function CaptureWindow() {
  const { t } = useTranslation();
  const [origin, setOrigin] = useState<{ x: number; y: number }>();
  const [selection, setSelection] = useState<CaptureSelection>();
  const [error, setError] = useState("");
  const hasSelection = Boolean(selection && selection.width >= 8 && selection.height >= 8);

  function updateSelection(event: MouseEvent<HTMLElement>) {
    if (!origin) return;
    setSelection(normalizeCaptureSelection(origin.x, origin.y, event.clientX, event.clientY));
  }

  const confirm = useCallback(async () => {
    if (!selection || !hasSelection) return;
    setError("");
    try {
      await runCommand("confirm_screen_capture", { selection });
    } catch (captureError) {
      setError(String(captureError));
    }
  }, [hasSelection, selection]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") runCommandQuiet("cancel_screen_capture");
      if (event.key === "Enter" && hasSelection) void confirm();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirm, hasSelection]);

  return (
    <main
      className="capture-shell"
      onContextMenu={(event) => {
        event.preventDefault();
        if (hasSelection) void confirm();
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        setOrigin({ x: event.clientX, y: event.clientY });
        setSelection({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      }}
      onMouseMove={(event) => {
        if ((event.buttons & 1) !== 0) updateSelection(event);
      }}
      onMouseUp={(event) => {
        updateSelection(event);
        setOrigin(undefined);
      }}
    >
      <p className="capture-hint">{t("capture.hint", "拖动框选截图区域，确认后才会读取屏幕内容")}</p>
      {error && <div className="capture-error" role="alert">{error}</div>}
      {selection && (
        <div
          className="capture-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}
      <div className={`capture-actions${hasSelection ? " is-ready" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <strong>{hasSelection ? t("capture.selected", "截图区域已选择") : t("capture.selectHint", "请拖动鼠标框选区域")}</strong>
          <span>
            {hasSelection && selection
              ? t("capture.sizeHint", "{width} × {height} · 点击右键确认")
                  .replace("{width}", String(Math.round(selection.width)))
                  .replace("{height}", String(Math.round(selection.height)))
              : t("capture.escHint", "按 Esc 取消")}
          </span>
        </div>
        <button type="button" onClick={() => runCommand("cancel_screen_capture")}>{t("capture.cancel", "取消")}</button>
        <button className="capture-confirm" type="button" disabled={!hasSelection} onClick={() => void confirm()}>
          {t("capture.confirm", "确认截图")}
        </button>
      </div>
    </main>
  );
}
