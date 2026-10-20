import { useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../app/appRuntime";

/** Change only native window presentation, keeping the mounted conversation intact. */
export function useConversationSurface(onError: (error: unknown) => void) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const quickSize = useRef({ width: 480, height: 420 });
  const busy = useRef(false);

  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const next = !expanded;
    try {
      if (isTauriRuntime) {
        const window = getCurrentWindow();
        if (next) {
          const size = await window.innerSize();
          quickSize.current = size.toLogical(await window.scaleFactor());
        } else {
          if (await window.isFullscreen()) await window.setFullscreen(false);
          if (await window.isMaximized()) await window.unmaximize();
        }
        await window.setDecorations(next);
        await window.setSkipTaskbar(!next);
        await window.setSize(new LogicalSize(
          next ? Math.max(860, quickSize.current.width) : quickSize.current.width,
          next ? Math.max(700, quickSize.current.height) : quickSize.current.height,
        ));
      }
      setExpanded(next);
    } catch (error) {
      onError(error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return { expanded, pending, toggle };
}
