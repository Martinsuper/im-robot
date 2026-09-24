/**
 * 长回复折叠（02 §7.3）。
 *
 * 规则：超过 `FOLD_THRESHOLD` 字的回复默认只显示前 `FOLD_TARGET` 字，
 * 底部给「展开全部」。**含代码块时不折叠**——02 §7.3 明确要求代码块完整展示，
 * 而按字数截断会把代码切成半截，渲染出来比不折叠更糟。
 *
 * 截断点选在段落边界（空行）或换行处，而不是硬切字符：
 * 硬切会把 Markdown 结构（列表、表格、引用）截断成半截，渲染结果不可预测。
 */

export const FOLD_THRESHOLD = 1200;
export const FOLD_TARGET = 600;

/** 是否包含围栏代码块（``` 或 ~~~）。 */
export function hasCodeBlock(markdown: string): boolean {
  return /^\s*(```|~~~)/m.test(markdown);
}

export function shouldFoldReply(markdown: string): boolean {
  if (hasCodeBlock(markdown)) return false;
  return markdown.length > FOLD_THRESHOLD;
}

/**
 * 截到 `FOLD_TARGET` 附近，并回退到最近的段落/行边界。
 * 若整段都没有可用的边界（极端情况），就直接按字数截断，保证一定有结果。
 */
export function foldReply(markdown: string, target = FOLD_TARGET): string {
  if (markdown.length <= target) return markdown;
  const window = markdown.slice(0, target);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak > target * 0.4) {
    return window.slice(0, paragraphBreak).trimEnd();
  }
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak > target * 0.4) {
    return window.slice(0, lineBreak).trimEnd();
  }
  const sentenceBreak = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
  );
  if (sentenceBreak > target * 0.4) {
    return window.slice(0, sentenceBreak + 1);
  }
  return window;
}

/** 折叠后还剩多少字没显示，用于「展开全部（还有 N 字）」。 */
export function foldedRemainder(markdown: string, target = FOLD_TARGET): number {
  return Math.max(0, markdown.length - foldReply(markdown, target).length);
}
