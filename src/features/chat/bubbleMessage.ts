const BUBBLE_COMPANION_MESSAGE_KEY = "piko-bubble-companion-message";

function getStorage() {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return null;
  return window.localStorage;
}

export function getBubbleCompanionMessage() {
  try {
    return getStorage()?.getItem(BUBBLE_COMPANION_MESSAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setBubbleCompanionMessage(message: string) {
  try {
    getStorage()?.setItem(BUBBLE_COMPANION_MESSAGE_KEY, message);
  } catch {
    // 存储不可用时仍派发内存中的界面更新，避免影响当前会话。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string>("piko-bubble-companion-message-changed", { detail: message }));
  }
}

export function clearBubbleCompanionMessage() {
  try {
    getStorage()?.removeItem(BUBBLE_COMPANION_MESSAGE_KEY);
  } catch {
    // 与写入相同：清理失败不应阻断当前界面状态更新。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string>("piko-bubble-companion-message-changed", { detail: "" }));
  }
}
