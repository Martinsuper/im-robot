import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--bundle", "--audit"].includes(arg)))
  throw new Error("Usage: npm run verify:desktop -- [--bundle] [--audit]");
if (args.includes("--bundle") && process.platform !== "darwin")
  throw new Error("--bundle currently supports macOS only");
const directory = path.join(
  root,
  "artifacts",
  "acceptance",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(directory, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const stages = [
  ["verify", npm, ["run", "verify"]],
  ["e2e", npm, ["run", "test:e2e"]],
  [
    "contracts",
    "cargo",
    ["test", "--locked", "--manifest-path", "tools/contracts/Cargo.toml"],
  ],
  [
    "rust",
    "cargo",
    ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
  ],
  [
    "clippy",
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
  ],
  [
    "lite",
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--no-default-features",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  ],
  ["prepare-runtime", npm, ["run", "agent:prepare"]],
  ["runtime", npm, ["run", "smoke:runtime"]],
  ["packaged-agent", npm, ["run", "test:agent:packaged"]],
];
if (args.includes("--audit"))
  stages.push(
    ["npm-audit", npm, ["audit", "--json"]],
    ["agent-audit", npm, ["--prefix", "agent", "audit", "--json"]],
    [
      "rust-audit",
      "cargo",
      ["audit", "--file", "src-tauri/Cargo.lock", "--json"],
    ],
  );
if (process.platform !== "win32")
  stages.push(["build-scripts", npm, ["run", "test:build"]]);
if (process.platform === "darwin")
  stages.push(
    ["calendar", npm, ["run", "test:calendar"]],
    ["notifications", npm, ["run", "test:notifications-native"]],
  );
if (args.includes("--bundle"))
  stages.push(
    ["bundle", npm, ["run", "tauri", "--", "build", "--bundles", "app"]],
    ["inspect-bundle", process.execPath, ["scripts/inspect-macos-bundle.mjs"]],
  );
const report = {
  platform: process.platform,
  arch: process.arch,
  startedAt: new Date().toISOString(),
  stages: [],
};
let active;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    active?.kill(signal);
  });
for (const [name, command, commandArgs] of stages) {
  if (interrupted) break;
  const start = Date.now();
  const log = path.join(directory, `${name}.log`);
  console.log(`Running ${name}; log: ${log}`);
  const result = await new Promise((resolve) => {
    const stream = createWriteStream(log);
    const useNpmCli = command === npm && process.env.npm_execpath;
    const child = spawn(
      useNpmCli ? process.execPath : command,
      useNpmCli ? [process.env.npm_execpath, ...commandArgs] : commandArgs,
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    active = child;
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("error", (error) => stream.write(`${error.message}\n`));
    child.on("close", (code, signal) =>
      stream.end(() => resolve({ code, signal })),
    );
  });
  active = undefined;
  report.stages.push({ name, ...result, elapsedMs: Date.now() - start, log });
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`${name}: ${result.code === 0 ? "PASS" : "FAIL"}`);
  // Later stages can provide useful diagnostics even if an earlier check failed.
}
report.finishedAt = new Date().toISOString();
report.passed =
  !interrupted &&
  report.stages.length === stages.length &&
  report.stages.every((stage) => stage.code === 0);
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Acceptance ${report.passed ? "passed" : "failed"}: ${directory}`);
process.exitCode = report.passed ? 0 : 1;
