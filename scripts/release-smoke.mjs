import { spawn, spawnSync } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(rootDir, "src-tauri");
const bundleDmgDir = path.join(tauriDir, "target", "release", "bundle", "dmg");
const installDir = "/tmp/Piko-install-test";
const mountPoint = "/tmp/PikoInstallSmoke";
const installAppPath = path.join(installDir, "Piko.app");
const installedBinaryPath = path.join(installAppPath, "Contents", "MacOS", "im-robot");
const launchPattern = "/tmp/Piko-install-test/Piko.app/Contents/MacOS/im-robot";

function run(command, args, { cwd = rootDir, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (!allowFailure && result.status !== 0) {
    const commandLine = [command, ...args].join(" ");
    throw new Error(`Command failed: ${commandLine}`);
  }

  return result;
}

function runWithOutput(command, args, { cwd = rootDir } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const commandLine = [command, ...args].join(" ");
    const stderr = result.stderr?.trim() || result.stdout?.trim() || "";
    throw new Error(`Command failed: ${commandLine}${stderr ? `\n${stderr}` : ""}`);
  }

  return result.stdout ?? "";
}

async function latestDmg() {
  const entries = await readdir(bundleDmgDir, { withFileTypes: true });
  const dmgFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"));
  if (!dmgFiles.length) {
    throw new Error(`No dmg found in ${bundleDmgDir}`);
  }

  const sorted = await Promise.all(
    dmgFiles.map(async (entry) => {
      const fullPath = path.join(bundleDmgDir, entry.name);
      const stats = await stat(fullPath);
      return { fullPath, mtimeMs: stats.mtimeMs };
    }),
  );

  sorted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted[0].fullPath;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("release-smoke.mjs only supports macOS");
  }

  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild) {
    run("npm", ["run", "tauri", "--", "build"]);
  }

  const dmgPath = await latestDmg();

  await rm(installDir, { recursive: true, force: true });
  run("mkdir", ["-p", installDir]);
  run("mkdir", ["-p", mountPoint]);
  run("pkill", ["-f", launchPattern], { cwd: rootDir, allowFailure: true });

  let mounted = false;
  try {
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
    mounted = true;

    run("ditto", [path.join(mountPoint, "Piko.app"), installAppPath]);

    const plistExecutable = runWithOutput("plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      path.join(installAppPath, "Contents", "Info.plist"),
    ]).trim();
    if (plistExecutable !== "im-robot") {
      throw new Error(`Installed app bundle points to an unexpected executable: ${plistExecutable}`);
    }

    const fileOutput = runWithOutput("file", [installedBinaryPath]);
    if (!fileOutput.includes("arm64")) {
      throw new Error(`Installed binary is not arm64: ${fileOutput.trim()}`);
    }

    const launched = spawn(installedBinaryPath, [], {
      cwd: installDir,
      detached: true,
      stdio: "ignore",
    });
    launched.unref();

    let running = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const status = spawnSync("pgrep", ["-f", launchPattern], { encoding: "utf8" });
      if (status.status === 0) {
        running = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!running) {
      throw new Error("Installed app did not stay running after launch");
    }

    console.log(`Smoke test passed for ${installAppPath}`);
  } finally {
    run("pkill", ["-f", launchPattern], { cwd: rootDir, allowFailure: true });
    if (mounted) {
      run("hdiutil", ["detach", mountPoint]);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
