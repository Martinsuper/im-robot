import { defineConfig } from "@playwright/test";
import fs from "node:fs";
// Use the Playwright-managed browser for reproducible rendering and teardown.
// An explicit executable override remains available for local browser debugging.
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (chromeExecutablePath && !fs.existsSync(chromeExecutablePath)) {
  throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  globalTimeout: 10 * 60_000,
  workers: 2,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    // i18n 接入后 UI 文案跟随浏览器语言；固定 zh-CN 保证中文选择器稳定
    locale: "zh-CN",
    trace: process.env.PIKO_UI_TRACE === "1" ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    launchOptions: chromeExecutablePath ? { executablePath: chromeExecutablePath } : undefined,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
