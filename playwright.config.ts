import { defineConfig } from "@playwright/test";
import { resolveChromiumExecutable } from "./scripts/playwright-browser-probe.mjs";
// Use the Playwright-managed browser for reproducible rendering and teardown.
// An explicit override remains available for local debugging; on Windows we also
// probe the default Playwright cache and system Chrome before falling back.
const chromeExecutablePath = resolveChromiumExecutable();

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
