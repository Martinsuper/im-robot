import { agentRuntimeFiles } from "./agent-runtime-files.mjs";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rust = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rust.status !== 0) throw new Error("Unable to determine Rust host target");
const host = rust.stdout.match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error("Rust host target missing");
const requestedTarget = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET;
if (requestedTarget && requestedTarget !== host) {
  throw new Error("Agent runtime must be prepared on its target platform; cross-compiling is unsupported");
}
const source = path.join(root, "agent");
const destination = path.join(root, "src-tauri", "agent-runtime");
mkdirSync(destination, { recursive: true });
for (const file of agentRuntimeFiles) {
  cpSync(path.join(source, file), path.join(destination, file));
}
const lock = readFileSync(path.join(source, "package-lock.json"), "utf8");
const stamp = path.join(destination, ".lock-stamp");
if (!existsSync(path.join(destination, "node_modules")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== lock) {
  const install = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: destination, stdio: "inherit", shell: process.platform === "win32",
  });
  if (install.status !== 0) throw new Error("Unable to install Pi Agent runtime");
  writeFileSync(stamp, lock);
}
const binaryDir = path.join(root, "src-tauri", "binaries");
mkdirSync(binaryDir, { recursive: true });
const binary = path.join(binaryDir, `piko-agent-node-${host}${process.platform === "win32" ? ".exe" : ""}`);
// Homebrew's node may depend on absolute local dylib paths. Ship the official
// self-contained distribution, not process.execPath from the build machine.
const nodeVersion = "22.23.3";
const binaryStamp = `${binary}.version`;
if (!existsSync(binary) || !existsSync(binaryStamp) || readFileSync(binaryStamp, "utf8") !== nodeVersion) {
  const platform = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
  if (!platform || !["arm64", "x64"].includes(process.arch)) throw new Error("Unsupported Agent runtime platform");
  const distribution = `node-v${nodeVersion}-${platform}-${process.arch}`;
  const archiveName = `${distribution}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  console.info(`Preparing official Node ${nodeVersion} for ${platform}-${process.arch}…`);
  const checksums = (await download(`${base}/SHASUMS256.txt`)).toString();
  const expected = checksums.split("\n").find((line) => line.trim().endsWith(` ${archiveName}`))?.split(/\s+/)[0];
  if (!expected) throw new Error("Node archive checksum missing");
  const archive = await download(`${base}/${archiveName}`);
  if (createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Node archive checksum mismatch");
  const temporary = mkdtempSync(path.join(tmpdir(), "piko-node-"));
  try {
    const archivePath = path.join(temporary, archiveName);
    writeFileSync(archivePath, archive);
    const extract = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:PIKO_NODE_ARCHIVE -DestinationPath $env:PIKO_NODE_DEST"], {
          env: { ...process.env, PIKO_NODE_ARCHIVE: archivePath, PIKO_NODE_DEST: temporary }, stdio: "inherit" })
      : spawnSync("tar", ["-xzf", archivePath, "-C", temporary], { stdio: "inherit" });
    if (extract.status !== 0) throw new Error("Unable to extract Node runtime");
    cpSync(path.join(temporary, distribution, process.platform === "win32" ? "node.exe" : "bin/node"), binary);
    cpSync(path.join(temporary, distribution, "LICENSE"), path.join(destination, "NODE-LICENSE.txt"));
    chmodSync(binary, 0o755);
    writeFileSync(binaryStamp, nodeVersion);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
console.info(`Pi Agent runtime ready (${host}, Node ${nodeVersion})`);
