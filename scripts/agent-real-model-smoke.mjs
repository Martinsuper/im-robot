// Read the existing Piko provider configuration without modifying it. All model
// work is constrained to a disposable fixture; only the exact `pwd` command is
// approved by this test, and no credential is included in its report.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.PIKO_CONFIG_DIR || path.join(homedir(), "Library/Application Support/com.duanluyao.imrobot");
const settings = JSON.parse(await readFile(path.join(configDir, "app-settings.json"), "utf8"));
const credentials = JSON.parse(await readFile(path.join(configDir, "api-credentials.json"), "utf8"));
const apiKey = credentials.apiKey || credentials.api_key || "";
const temporary = await mkdtemp(path.join(tmpdir(), "piko-real-model-"));
const workspace = path.join(temporary, "workspace");
await mkdir(workspace);
const sessionCwd = path.join(temporary, "session-context"); await mkdir(sessionCwd);
const marker = "PIKO_APPROVAL_REAL_TOOL_MARKER";
await writeFile(path.join(workspace, "approval-smoke.txt"), marker);
const output = path.join(root, "artifacts/agent-approval-fix");
await mkdir(output, { recursive: true });
const child = spawn(process.execPath, [process.env.PIKO_TEST_SIDECAR || path.join(root, "agent/sidecar.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
const events = [];
const redact = (value) => apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += redact(String(chunk)); });
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
try {
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Real model test timed out after 90 seconds")); }, 90000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(redact(line)); events.push(event);
      if (event.type === "app-tool") {
        send({ type: "app-result", callId: event.callId, ...(event.name === "piko_select_workspace" ? { result: { path: workspace } } : { error: "此测试不允许其他应用操作" }) });
      }
      if (event.type === "approval") {
        const allowed = event.tool === "bash" && /^\s*pwd\s*$/.test(event.arguments?.command || "");
        send({ type: "approval", approvalId: event.approvalId, allowed });
      }
      if (["completed", "failed", "cancelled"].includes(event.type)) { clearTimeout(timeout); resolve(event); }
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      if (!events.some((event) => ["completed", "failed", "cancelled"].includes(event.type))) reject(new Error(`Sidecar exited without result: ${stderr}`));
    });
    send({ type: "start", conversationId: "real-model-smoke", cwd: sessionCwd, unified: true, workspace: null, dataDir: path.join(temporary, "data"),
      provider: settings.ai.provider, model: settings.ai.model, baseUrl: settings.ai.baseUrl || settings.ai.base_url, apiKey,
      prompt: "这是工具调用回归测试。请先实际调用 bash 工具，命令必须精确为 pwd，然后调用 read 工具读取当前工作目录下的 approval-smoke.txt，将其中的标识原样汇报。不要访问工作目录外的文件，不要写入或删除文件。必须实际调用工具，不要只输出命令或用文字要求批准，批准由应用处理。" });
  });
  const summary = { terminal: result.type, approvals: events.filter((event) => event.type === "approval").length,
    tools: events.filter((event) => event.type === "tool-start").map((event) => event.tool),
    commandExecuted: events.some((event) => event.type === "tool-end" && event.tool === "bash" && !event.isError),
    markerRead: events.some((event) => event.type === "tool-end" && event.tool === "read" && event.output?.includes(marker)),
    markerReported: events.filter((event) => event.type === "delta").map((event) => event.text).join("").includes(marker) };
  await writeFile(path.join(output, "real-model-events.json"), JSON.stringify({ summary, events }, null, 2));
  console.info(JSON.stringify(summary));
  if (result.type !== "completed" || !summary.commandExecuted || !summary.markerRead || !summary.approvals) process.exitCode = 1;
} finally {
  child.kill("SIGKILL");
  await rm(temporary, { recursive: true, force: true });
}
