import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelLimits } from "./model-limits.mjs";
test("catalog metadata and explicit user limits override fallback caps", () => {
  const catalog = [{ id: "known", api: "openai-completions", contextWindow: 128000, maxTokens: 16000 }];
  assert.deepEqual(resolveModelLimits({ model: "known", api: "openai-completions" }, catalog), { contextWindow: 128000, maxTokens: 16000 });
  assert.deepEqual(resolveModelLimits({ model: "known", api: "openai-completions", contextWindow: 8192, maxOutputTokens: 2048 }, catalog), { contextWindow: 8192, maxTokens: 2048 });
  assert.throws(() => resolveModelLimits({ contextWindow: -1 }));
});
