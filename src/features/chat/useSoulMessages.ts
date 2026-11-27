import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { ackDismissed, ackHidden, ackResponded, ackShown, type SoulProactiveMessage } from "../soul/proactiveBridge";

/** S07/S08 灵魂主动消息：气泡展示、撤回对账与回执生命周期。 */
export function useSoulMessages({ active }: { active: boolean }) {
  const [soulMessage, setSoulMessage] = useState<SoulProactiveMessage | null>(null);
  const [soulReplyId, setSoulReplyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    let receivedLiveState = false;
    let activeIds: string[] | null = null;
    const unlisten = listen<SoulProactiveMessage>("soul:message", (event) => {
      receivedLiveState = true;
      setSoulMessage(event.payload);
    });
    const reconcile = listen<string[]>("soul:active", (event) => {
      activeIds = event.payload;
      setSoulMessage((current) => current && !event.payload.includes(current.id) ? null : current);
    });
    // Subscribe first, then recover a delivery emitted during WebView startup.
    // A newer event/revocation always wins over an in-flight recovery read.
    void Promise.all([unlisten, reconcile]).then(async () => {
      const message = (await runCommand("soul_current_message", undefined, null)) as SoulProactiveMessage | null;
      if (!disposed && !receivedLiveState && message && (activeIds === null || activeIds.includes(message.id))) setSoulMessage(message);
    });
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
      void reconcile.then((dispose) => dispose());
    };
  }, []);

  // S08 回执生命周期：真实显示和隐藏都上报，避免隐藏被当成已展示。
  useEffect(() => {
    if (!soulMessage) return;
    const report = () => {
      if (active && document.visibilityState === "visible") ackShown(soulMessage.id);
      else ackHidden(soulMessage.id);
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => { document.removeEventListener("visibilitychange", report); ackHidden(soulMessage.id); };
  }, [soulMessage, active]);

  function respondToSoul() {
    if (!soulMessage) return;
    ackResponded(soulMessage.id);
    setSoulReplyId(soulMessage.id);
    setSoulMessage(null);
  }

  function dismissSoul() {
    if (!soulMessage) return;
    ackDismissed(soulMessage.id);
    setSoulMessage(null);
  }

  return { soulMessage, soulReplyId, setSoulReplyId, respondToSoul, dismissSoul };
}

export type SoulMessagesApi = ReturnType<typeof useSoulMessages>;
