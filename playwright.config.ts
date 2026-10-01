import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

function detectChromeExecutable() {
  const localAppData = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : undefined;
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    localAppData,
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => fs.existsSync(candidate));
}

const chromeExecutablePath = detectChromeExecutable();

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: chromeExecutablePath ? { executablePath: chromeExecutablePath } : undefined,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
