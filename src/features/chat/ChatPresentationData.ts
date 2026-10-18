import "katex/dist/katex.min.css";
import { Coffee,FileText,MessageCircle } from "lucide-react";
import { isValidElement,type ReactNode } from "react";
import { runCommand } from "../app/appRuntime";
import "./replyStatus.css";


export function extractMarkdownText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractMarkdownText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractMarkdownText(node.props.children);
  return "";
}


export function textForSpeech(text: string) {
  return text
    // Why: 朗读前剥掉 emoji。字符类里确实包含 ZWJ / 变体选择符等组合序列，
    // 这是有意的（要逐个码点剔除），不是漏写 u 标志导致的误解，故关闭该规则。
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F\u20E3]/gu, "");
}


export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}


export function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\n+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export const SUGGESTION_ICONS = [Coffee, FileText, MessageCircle];


/** 打开面板并定位到「设置 → 对话与模型」。 */
export function openModelSettings() {
  void runCommand("open_panel", { tab: "settings" });
}
