import { useEffect, useRef, type PointerEvent } from "react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../../app/appRuntime";

// Poll the OS cursor: DOM mouseenter cannot fire while the window ignores input.
// Use a single async loop so stale polls cannot overwrite a newer decision.
export function usePetClickThrough() {
  const pointerDown = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const petWindow = getCurrentWindow();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ignored: boolean | undefined;

    async function poll() {
      try {
        const [cursor, origin, scale] = await Promise.all([
          cursorPosition(), petWindow.innerPosition(), petWindow.scaleFactor(),
        ]);
        if (disposed) return;
        const x = (cursor.x - origin.x) / scale;
        const y = (cursor.y - origin.y) / scale;
        const interactive = Array.from(document.querySelectorAll<HTMLElement>("[data-pet-interactive]"))
          .some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
              && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
          });
        const next = !pointerDown.current && !interactive;
        if (next !== ignored) {
          await petWindow.setIgnoreCursorEvents(next);
          ignored = next;
          // A press can arrive while the native write is in flight. Never leave
          // a captured drag ignored until the next cursor poll.
          if (!disposed && next && pointerDown.current) {
            await petWindow.setIgnoreCursorEvents(false);
            ignored = false;
          }
        }
      } catch (error) {
        // Fail open for pet interaction if an OS cursor query fails.
        if (!disposed) {
          await petWindow.setIgnoreCursorEvents(false).catch(() => {});
          ignored = false;
          console.error("[pet] click-through update failed", error);
        }
      } finally {
        if (disposed) {
          // Also runs after any in-flight native write has completed.
          await petWindow.setIgnoreCursorEvents(false).catch(() => {});
        } else {
          timer = setTimeout(() => { void poll(); }, 24);
        }
      }
    }
    void poll();
    return () => {
      disposed = true;
      pointerDown.current = false;
      if (timer !== undefined) clearTimeout(timer);
      void petWindow.setIgnoreCursorEvents(false).catch(() => {});
    };
  }, []);

  return {
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      pointerDown.current = true;
      // Includes reminder buttons: release/cancel must arrive even outside the window.
      if (event.target instanceof HTMLElement) event.target.setPointerCapture(event.pointerId);
    },
    onPointerUpCapture: () => { pointerDown.current = false; },
    onPointerCancelCapture: () => { pointerDown.current = false; },
  };
}
