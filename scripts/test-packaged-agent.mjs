import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rust = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rust.status !== 0) throw new Error(rust.stderr || "rustc unavailable");
const host = rust.stdout.match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error("Missing native target");
const binary = path.join(
  root,
  "src-tauri",
  "binaries",
  `piko-agent-node-${host}${process.platform === "win32" ? ".exe" : ""}`,
);
const tests = readdirSync(path.join(root, "agent"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "agent", name));
if (!tests.length) throw new Error("No Agent tests found");
const result = spawnSync(binary, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  timeout: 180_000,
  env: {
    ...process.env,
    PIKO_TEST_NODE: binary,
    PIKO_TEST_SIDECAR: path.join(
      root,
      "src-tauri",
      "agent-runtime",
      "sidecar.mjs",
    ),
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
