import { useEffect, useMemo, useState, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { useStableEvent } from "../../hooks/useStableEvent";
import { claimCapture, captureBelongsTo, releaseCapture } from "./captureOwnership";
import type { useToast } from "../../components/feedback/toastStore";
import type { AttachmentAction, AttachmentPreview, ScreenshotPreview } from "../../types/appTypes";

type ChatAttachmentsOptions = {
  tabId?: string;
  activeTabRef: RefObject<boolean>;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
  toast: ReturnType<typeof useToast>;
};

/**
 * 附件与截图维度：拖拽文件、文件选择、草稿附件/截图、截图采集与窗口焦点回填。
 * IPC 命令名与事件协议保持不变，窗口组件只负责渲染与装配。
 */
export function useChatAttachments({ tabId, activeTabRef, promptInputRef, toast }: ChatAttachmentsOptions) {
  const attachmentContext = useMemo(() => tabId ? { contextId: tabId } : undefined, [tabId]);
  const [attachment, setAttachment] = useState<AttachmentPreview>();
  const [attachmentAction, setAttachmentAction] = useState<AttachmentAction>("summarize");
  const [screenshot, setScreenshot] = useState<ScreenshotPreview>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const hasInputContext = Boolean(attachment || screenshot || isDraggingFile);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (!activeTabRef.current) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDraggingFile(true);
        return;
      }
      setIsDraggingFile(false);
      if (event.payload.type !== "drop") return;
      if (event.payload.paths.length !== 1) {
        toast.error("一次只能处理一个文本文件。");
        return;
      }

      void runCommand("prepare_text_attachment", {
        path: event.payload.paths[0],
        ...attachmentContext,
      })
        .then(setAttachment)
        .catch((error) => toast.error(toUserMessage(error, "附件读取失败，请重试。")));
    });

    return () => {
      disposed = true;
      void unlisten.then((dispose) => { if (!disposed) dispose(); });
    };
  }, [toast, attachmentContext, activeTabRef]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    const refreshScreenshot = () => {
      void runCommand("get_screen_capture_preview", undefined, null)
        .then((preview) => setScreenshot(preview ?? undefined));
    };
    if (!tabId) refreshScreenshot();
    const unlisten = listen<ScreenshotPreview>("screenshot-ready", (event) => {
      if (!captureBelongsTo(tabId, activeTabRef.current)) return;
      setScreenshot(event.payload);
    });
    let focusTimer: number | undefined;
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      window.clearTimeout(focusTimer);
      if (!focused || !activeTabRef.current) return;
      if (!tabId) refreshScreenshot();
      // Cancel delayed composer focus when a detached preview takes focus.
      focusTimer = window.setTimeout(() => {
        promptInputRef.current?.focus();
      }, 80);
    });
    return () => {
      disposed = true;
      window.clearTimeout(focusTimer);
      void unlisten.then((dispose) => { if (!disposed) dispose(); });
      void unlistenFocus.then((dispose) => { if (!disposed) dispose(); });
    };
  }, [tabId, activeTabRef, promptInputRef]);

  const beginCapture = useStableEvent(async () => {
    claimCapture(tabId);
    try { await runCommand("begin_screen_capture"); }
    catch (error) { releaseCapture(tabId); toast.error(toUserMessage(error, "截图失败，请重试。")); }
  });

  useEffect(() => {
    if (!isTauriRuntime) return;
    const pending = listen("bubble-capture-requested", () => {
      if (!activeTabRef.current) return;
      void beginCapture();
    });
    return () => { void pending.then((unlisten) => unlisten()); };
  }, [beginCapture, activeTabRef]);

  async function clearAttachment() {
    await runCommand("clear_text_attachment", attachmentContext);
    setAttachment(undefined);
  }

  async function chooseAttachment() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt", "md", "json", "csv", "log"] }],
    });
    if (!path) return;
    try {
      setAttachment(await runCommand("prepare_text_attachment", { path, ...attachmentContext }));
    } catch (error) {
      toast.error(toUserMessage(error, "附件读取失败，请重试。"));
    }
  }

  async function clearScreenshot() {
    if (!tabId) await runCommand("clear_screen_capture");
    setScreenshot(undefined);
  }

  return {
    attachment, setAttachment, attachmentAction, setAttachmentAction,
    screenshot, setScreenshot, isDraggingFile, attachmentContext, hasInputContext,
    chooseAttachment, clearAttachment, clearScreenshot, beginCapture,
  };
}

export type ChatAttachmentsApi = ReturnType<typeof useChatAttachments>;
