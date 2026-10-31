import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sidecar = process.env.PIKO_TEST_SIDECAR || fileURLToPath(new URL("sidecar.mjs", import.meta.url));
export function stream(res, delta, finishReason = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ id: "mock", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
}

export function toolResponse(res, name, args, id = "call-1") {
  stream(res, { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}

export async function fixture(t, handler) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "piko-agent-")));
  const cwd = path.join(root, "workspace"); await mkdir(cwd);
  const requests = [];
  const httpRequests = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      httpRequests.push({ url: req.url, headers: req.headers });
      handler(req, res, requests);
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  function run({ prompt = "请执行任务", conversationId = "test-session", onEvent,
    workingDirectory = cwd, provider = "openai-compatible", model = "mock", unified = false, passport = false, autoApproveCommands = false, workspace = cwd, businessTools = [], history, images, readOnly = false, resumeRoot, requestId, systemPrompt, serializeSystemTools = false, taskKind, policy, budget, gitMode, verifyCommand, projectId } = {}) {
    const child = spawn(process.env.PIKO_TEST_NODE || process.execPath, [sidecar], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
    const events = []; let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Timed out: ${JSON.stringify(events)}\n${stderr}`)); }, 20000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line); events.push(event); onEvent?.(event, send);
          if (["completed", "failed", "cancelled"].includes(event.type)) { clearTimeout(timeout); resolve(events); }
        } catch (error) { clearTimeout(timeout); child.kill("SIGKILL"); reject(error); }
      });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("exit", () => {
        clearTimeout(timeout);
        if (!events.some((e) => ["completed", "failed", "cancelled"].includes(e.type))) reject(new Error(`Exited: ${stderr}\n${JSON.stringify(events)}`));
      });
    });
    send({ type: "start", cwd: workingDirectory, dataDir: path.join(root, "data"), conversationId,
      provider, model, unified, passport, autoApproveCommands, workspace, businessTools, history, images, readOnly, resumeRoot, requestId, systemPrompt, serializeSystemTools, taskKind, policy, budget, gitMode, verifyCommand, projectId, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "mock-key", prompt });
    return Object.assign(result, { send, child, events, exited });
  }
  return { root, cwd, run, requests, httpRequests };
}

export async function within(promise, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Process did not terminate promptly")), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
