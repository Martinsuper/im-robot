import { useCallback, useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../app/appRuntime";
import { fitWorkspace, type WorkspaceBounds } from "./workspaceLayout";
import { emit } from "@tauri-apps/api/event";

/** Change only native window presentation, keeping the mounted conversation intact. */
export function useConversationSurface(onError: (error: unknown) => void) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const workspaceSize = useRef<WorkspaceBounds | null>(null);
  const workspaceResized = useRef(false);
  const errorHandler = useRef(onError);
  useEffect(() => { errorHandler.current = onError; }, [onError]);

  /** Resize the same native window, retaining the chat's mounted state and original size. */
  const setWorkspaceOpen = useCallback(async (open: boolean): Promise<boolean> => {
    if (busy.current) return false;
    if (Boolean(workspaceSize.current) === open) return true;
    busy.current = true;
    setPending(true);
    try {
      if (isTauriRuntime) {
        const nativeWindow = getCurrentWindow();
        if (open) {
          const scale = await nativeWindow.scaleFactor();
          const size = (await nativeWindow.innerSize()).toLogical(scale);
          const position = (await nativeWindow.outerPosition()).toLogical(scale);
          const monitor = await currentMonitor();
          await emit("workspace-visibility", true);
          if (monitor) {
            const area = monitor.workArea;
            const bounds = fitWorkspace({ ...position, ...size }, {
              x: area.position.x / monitor.scaleFactor, y: area.position.y / monitor.scaleFactor,
              width: area.size.width / monitor.scaleFactor, height: area.size.height / monitor.scaleFactor,
            });
            workspaceResized.current = bounds.width !== size.width || bounds.height !== size.height || bounds.x !== position.x || bounds.y !== position.y;
            if (workspaceResized.current) {
              await nativeWindow.setSize(new LogicalSize(bounds.width, bounds.height));
              await nativeWindow.setPosition(new LogicalPosition(bounds.x, bounds.y));
            }
          }
          workspaceSize.current = { ...size, ...position };
        } else {
          if (workspaceResized.current) {
            if (await nativeWindow.isFullscreen()) await nativeWindow.setFullscreen(false);
            if (await nativeWindow.isMaximized()) await nativeWindow.unmaximize();
            const size = workspaceSize.current!;
            await nativeWindow.setSize(new LogicalSize(size.width, size.height));
            await nativeWindow.setPosition(new LogicalPosition(size.x, size.y));
          }
          await emit("workspace-visibility", false);
          workspaceSize.current = null;
        }
      } else {
        workspaceSize.current = open ? { x: 0, y: 0, width: 480, height: 420 } : null;
      }
      return true;
    } catch (error) {
      if (isTauriRuntime && open && !workspaceSize.current) {
        await emit("workspace-visibility", false).catch(() => undefined);
      }
      errorHandler.current(error);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);

  return { pending, setWorkspaceOpen };
}
