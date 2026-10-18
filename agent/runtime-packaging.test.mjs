import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentRuntimeFiles } from "../scripts/agent-runtime-files.mjs";

test("packaged sources contain the entire local sidecar import graph", async () => {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.ok(agentRuntimeFiles.includes(file), `Missing runtime dependency: ${file}`);
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']\.\/([^"']+)["']/g)) {
      await visit(match[1]);
    }
  }
  await visit("sidecar.mjs");
  for (const file of agentRuntimeFiles) await readFile(new URL(file, import.meta.url));
});
