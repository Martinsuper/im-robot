import { useEffect, useState, type MouseEvent } from "react";
import type { CaptureSelection } from "../../types/appTypes";
import { normalizeCaptureSelection } from "../app/appShared";
import { runCommand } from "../app/appRuntime";

export function CaptureWindow() {
  const [origin, setOrigin] = useState<{ x: number; y: number }>();
  const [selection, setSelection] = useState<CaptureSelection>();
  const [error, setError] = useState("");
  const hasSelection = Boolean(selection && selection.width >= 8 && selection.height >= 8);

  function updateSelection(event: MouseEvent<HTMLElement>) {
    if (!origin) return;
    setSelection(normalizeCaptureSelection(origin.x, origin.y, event.clientX, event.clientY));
  }

  async function confirm() {
    if (!selection || !hasSelection) return;
    setError("");
    try {
      await runCommand("confirm_screen_capture", { selection });
    } catch (captureError) {
      setError(String(captureError));
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") void runCommand("cancel_screen_capture");
      if (event.key === "Enter" && hasSelection) void confirm();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasSelection, selection]);

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
      <p className="capture-hint">拖动框选截图区域，确认后才会读取屏幕内容</p>
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
          <strong>{hasSelection ? "截图区域已选择" : "请拖动鼠标框选区域"}</strong>
          <span>
            {hasSelection && selection
              ? `${Math.round(selection.width)} × ${Math.round(selection.height)} · 点击右键确认`
              : "按 Esc 取消"}
          </span>
        </div>
        <button type="button" onClick={() => runCommand("cancel_screen_capture")}>取消</button>
        <button className="capture-confirm" type="button" disabled={!hasSelection} onClick={() => void confirm()}>
          确认截图
        </button>
      </div>
    </main>
  );
}
