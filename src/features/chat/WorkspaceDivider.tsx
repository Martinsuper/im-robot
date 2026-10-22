import { useRef, type PointerEvent } from "react";

/** Resize the auxiliary panel without changing the native window or chat state. */
export function WorkspaceDivider({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maximum = Math.min(480, Math.max(360, window.innerWidth - 480));
  const update = (next: number) => onChange(Math.round(Math.min(480, Math.max(360, Math.min(next, window.innerWidth - 480)))));
  function finish(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div className="workspace-divider" role="separator" aria-label="调整面板宽度" aria-orientation="vertical"
    aria-valuemin={360} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} 像素`} tabIndex={0} title="拖动调整宽度；方向键微调，双击恢复默认"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { if (drag.current) update(drag.current.width + drag.current.x - event.clientX); }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => update(400)}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      update(event.key === "Home" ? 360 : event.key === "End" ? 480 : width + (event.key === "ArrowLeft" ? 20 : -20));
    }} />;
}
