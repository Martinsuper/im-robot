export function resolveModelLimits(input, catalog = []) {
  const known = catalog.find((model) => model.id === input.model && model.api === input.api);
  const contextWindow = input.contextWindow || known?.contextWindow || 32000;
  let maxTokens = input.maxOutputTokens || known?.maxTokens || 4096;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048 || contextWindow > 2_000_000) throw new Error("无效的模型上下文窗口");
  maxTokens = Math.min(maxTokens, Math.floor(contextWindow / 2));
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128) throw new Error("无效的模型输出上限");
  return { contextWindow, maxTokens };
}
