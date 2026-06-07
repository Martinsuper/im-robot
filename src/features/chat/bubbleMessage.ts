const BUBBLE_COMPANION_MESSAGE_KEY = "piko-bubble-companion-message";

export function getBubbleCompanionMessage() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(BUBBLE_COMPANION_MESSAGE_KEY) ?? "";
}

export function setBubbleCompanionMessage(message: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BUBBLE_COMPANION_MESSAGE_KEY, message);
  window.dispatchEvent(new CustomEvent<string>("piko-bubble-companion-message-changed", { detail: message }));
}

export function clearBubbleCompanionMessage() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BUBBLE_COMPANION_MESSAGE_KEY);
  window.dispatchEvent(new CustomEvent<string>("piko-bubble-companion-message-changed", { detail: "" }));
}
