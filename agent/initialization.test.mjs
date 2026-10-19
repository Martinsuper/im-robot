import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function stalledRuntime(t) {
  const root = await mkdtemp(path.join(tmpdir(), "piko-startup-"));
  const source = fileURLToPath(new URL(".", import.meta.url));
  for (const file of await readdir(source)) {
    if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) await copyFile(path.join(source, file), path.join(root, file));
  }
  // Simulate an SDK import that never resolves, before any model request.
  await writeFile(path.join(root, "sdk-adapter.mjs"), "await new Promise(() => {}); export const prepareAgent = () => {}; export const SessionStore = {}; export const fileTools = () => [];\n");
  const child = spawn(process.execPath, [path.join(root, "sidecar.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); });
  const events = [];
  createInterface({ input: child.stdout }).on("line", line => events.push(JSON.parse(line)));
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  const exited = new Promise(resolve => child.on("exit", (code) => resolve(code)));
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");
  child.stdin.on("error", () => {});
  send({ type: "start", cwd: root, dataDir: root, conversationId: "startup-test", requestId: "startup-request", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "mock", prompt: "test", timeoutSeconds: 5 });
  return { events, exited, send, diagnostics: () => diagnostics };
}

test("a stalled SDK import fails within the initialization deadline", { timeout: 10000 }, async t => {
  const run = await stalledRuntime(t);
  assert.equal(await run.exited, 1);
  assert.equal(run.events.at(-1).type, "failed");
  assert.match(run.events.at(-1).message, /初始化超时/);
  assert.ok(!run.events.some(event => event.type === "started" || event.type === "tool-start"));
  assert.match(run.diagnostics(), /loading SDK/);
});

test("cancel terminates a stalled SDK import promptly", { timeout: 5000 }, async t => {
  const run = await stalledRuntime(t);
  const until = Date.now() + 2000;
  while (!run.diagnostics().includes("loading SDK") && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  run.send({ type: "cancel", requestId: "startup-request" });
  assert.equal(await run.exited, 0);
  assert.equal(run.events.at(-1).type, "cancelled");
});
