import { expect, test, type Page } from "@playwright/test";

/** Exercise the real settings UI with an instrumented IPC boundary, never real keys. */
async function installSettingsBackend(page: Page, mode: "persistent" | "lost" | "failure") {
  await page.addInitScript(({ mode }) => {
    const state = {
      quietMode: "balanced", companionName: "Piko", theme: "blue", language: "zh-CN",
      sensingPaused: false, breakRemindersEnabled: true, breakReminderIntervalMinutes: 45,
      breakReminderCooldownMinutes: 30, breakReminderQuietHoursEnabled: false,
      breakReminderQuietHoursStart: "22:00", breakReminderQuietHoursEnd: "08:00",
      hasApiKey: false, htmlPreviewEnabled: false, agentAutoApproveCommands: false, globalShortcut: "CmdOrCtrl+Shift+Space",
      ai: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:8317/v1",
        model: "gpt-6-luna", speechModel: "base", temperature: 0.7, timeoutSeconds: 120 },
    };
    let storedKey = "";
    const calls: Array<{ command: string; args: unknown }> = [];
    const bridge = window as unknown as Record<string, unknown>;
    bridge.__settingsCalls = calls;
    bridge.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    bridge.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "panel" }, currentWebview: { label: "panel" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      async invoke(command: string, args?: { input?: Record<string, unknown>; enabled?: boolean }) {
        calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
        if (command === "get_settings") return structuredClone(state);
        if (command === "update_agent_auto_approve_commands") {
          if (mode === "failure") throw "Settings storage unavailable";
          state.agentAutoApproveCommands = args?.enabled === true;
          return structuredClone(state);
        }
        if (command === "update_ai_settings") {
          if (mode === "failure") throw "Keychain storage unavailable";
          const { apiKey, ...ai } = args!.input!;
          state.ai = ai as typeof state.ai;
          if (mode === "persistent" && typeof apiKey === "string") storedKey = apiKey;
          state.hasApiKey = Boolean(storedKey);
          return structuredClone(state);
        }
        if (command === "list_models") {
          if (!storedKey) throw "HTTP 401: Invalid API key";
          return [{ id: "gpt-6-luna" }];
        }
        if (command.startsWith("plugin:")) return command.includes("listen") ? 1 : false;
        if (command === "get_focus_state") return { phase: "idle", remainingSeconds: 0, todayFocusSeconds: 0 };
        return [];
      },
    };
  }, { mode });
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "设置" }).click();
  await page.locator("#settings-group-ai > summary").click();
  await expect(page.locator("#settings-group-ai").getByLabel("Model", { exact: true })).toHaveValue("gpt-6-luna");
}

test("save and test submits the typed key before fetching models, and preserves it on retry", async ({ page }) => {
  await installSettingsBackend(page, "persistent");
  await page.locator('#settings-group-ai input[type="password"]').fill("  ui-test-key-not-a-secret  ");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.locator("#settings-group-ai").getByText("已连接：gpt-6-luna", { exact: true })).toBeVisible();
  await expect(page.locator('#settings-group-ai input[type="password"]')).toHaveValue("");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.locator("#settings-group-ai").getByText("已连接：gpt-6-luna", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as {
    __settingsCalls: Array<{ command: string; args: { input?: Record<string, unknown> } }>;
  }).__settingsCalls.filter((call) => ["update_ai_settings", "list_models"].includes(call.command)));
  expect(calls.map((call) => call.command)).toEqual(["update_ai_settings", "list_models", "update_ai_settings", "list_models"]);
  expect(calls[0].args.input).toMatchObject({ apiKey: "ui-test-key-not-a-secret", model: "gpt-6-luna" });
  expect(calls[2].args.input).not.toHaveProperty("apiKey");
});

test("reproduces invalid-key UI when the backend loses a correctly submitted key", async ({ page }, testInfo) => {
  await installSettingsBackend(page, "lost");
  await page.locator('#settings-group-ai input[type="password"]').fill("ui-test-key-not-a-secret");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.locator("#settings-group-ai").getByText(/连接失败：API Key 无效或已过期/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("lost-key.png"), fullPage: true });
});

test("does not test the connection or clear the input if saving fails", async ({ page }) => {
  await installSettingsBackend(page, "failure");
  await page.locator('#settings-group-ai input[type="password"]').fill("ui-test-key-not-a-secret");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.locator("#settings-group-ai").getByText(/连接失败/)).toBeVisible();
  await expect(page.locator('#settings-group-ai input[type="password"]')).toHaveValue("ui-test-key-not-a-secret");
  expect(await page.evaluate(() => (window as unknown as {
    __settingsCalls: Array<{ command: string }>;
  }).__settingsCalls.some((call) => call.command === "list_models"))).toBe(false);
});


test("command auto approval can be enabled and disabled in settings", async ({ page }) => {
  await installSettingsBackend(page, "persistent");
  await page.locator("#settings-group-system > summary").click();
  const toggle = page.getByRole("checkbox", { name: "始终自动批准命令执行" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  const calls = await page.evaluate(() => (window as unknown as {
    __settingsCalls: Array<{ command: string; args: unknown }>;
  }).__settingsCalls.filter((call) => call.command === "update_agent_auto_approve_commands"));
  expect(calls.map((call) => call.args)).toEqual([{ enabled: true }, { enabled: false }]);
});

test("failed command permission save keeps automatic approval disabled", async ({ page }) => {
  await installSettingsBackend(page, "failure");
  await page.locator("#settings-group-system > summary").click();
  const toggle = page.getByRole("checkbox", { name: "始终自动批准命令执行" });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
