import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const CHROMIUM_ENV_VAR = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";

/**
 * Resolve an explicit Chromium binary for Playwright.
 *
 * macOS/Linux keep using Playwright's managed browser. On Windows we also probe
 * the default Playwright cache and a system Chrome install, so local runs do
 * not need to set an environment variable by hand. Every input is injectable
 * so the Windows path logic can be tested on any host OS.
 */
export function resolveChromiumExecutable({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readdir = (directory) => (exists(directory) ? readdirSync(directory) : []),
} = {}) {
  const override = env[CHROMIUM_ENV_VAR];
  if (override) {
    if (!exists(override)) {
      throw new Error(`${CHROMIUM_ENV_VAR} does not exist: ${override}`);
    }
    return override;
  }
  if (platform !== "win32") return undefined;

  const join = platform === "win32" ? path.win32.join : path.join;
  const localAppData =
    env.LOCALAPPDATA ||
    (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : undefined);
  const candidates = [];

  if (localAppData) {
    const root = join(localAppData, "ms-playwright");
    const entries = readdir(root);
    for (const entry of [...entries].sort().reverse()) {
      if (!entry.startsWith("chromium-")) continue;
      candidates.push(join(root, entry, "chrome-win", "chrome.exe"));
      candidates.push(join(root, entry, "chrome-win64", "chrome.exe"));
    }
  }
  for (const programFiles of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]) {
    if (programFiles) {
      candidates.push(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
    }
  }

  return candidates.find(exists);
}
