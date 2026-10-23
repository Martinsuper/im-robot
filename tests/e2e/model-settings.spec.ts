import { expect, test, type Page } from "@playwright/test";

/** Exercise the real settings UI with an instrumented IPC boundary, never real keys. */
async function installSettingsBackend(
  page: Page,
  mode: "persistent" | "lost" | "failure",
) {
  await page.addInitScript(
    ({ mode }) => {
      const state = {
        quietMode: "balanced",
        companionName: "Piko",
        theme: "blue",
        language: "zh-CN",
        sensingPaused: false,
        breakRemindersEnabled: true,
        breakReminderIntervalMinutes: 45,
        breakReminderCooldownMinutes: 30,
        breakReminderQuietHoursEnabled: false,
        breakReminderQuietHoursStart: "22:00",
        breakReminderQuietHoursEnd: "08:00",
        hasApiKey: false,
        htmlPreviewEnabled: false,
        agentAutoApproveCommands: false,
        globalShortcut: "CmdOrCtrl+Shift+Space",
        ai: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8317/v1",
          model: "gpt-6-luna",
          speechModel: "base",
          temperature: 0.7,
          timeoutSeconds: 120,
        },
      };
      let storedKey = "";
      const calls: Array<{ command: string; args: unknown }> = [];
      const bridge = window as unknown as Record<string, unknown>;
      bridge.__settingsCalls = calls;
      bridge.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      bridge.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "panel" },
          currentWebview: { label: "panel" },
        },
        transformCallback: () => 1,
        unregisterCallback() {},
        async invoke(
          command: string,
          args?: { input?: Record<string, unknown>; enabled?: boolean },
        ) {
          calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
          if (
            ["get_pet_state", "migrate_pet_state", "save_pet_state"].includes(
              command,
            )
          ) {
            const owner = window as unknown as {
              __petWire?: {
                schemaVersion: number;
                initialized: boolean;
                entries: Record<
                  string,
                  { revision: number; value: string | null }
                >;
              };
            };
            const pet = (owner.__petWire ??= {
              schemaVersion: 1,
              initialized: true,
              entries: {},
            });
            const payload = (args ?? {}) as Record<string, unknown>;
            if (command === "save_pet_state") {
              const key = String(payload.key);
              const previous = pet.entries[key] ?? { revision: 0, value: null };
              if (previous.revision !== payload.expectedRevision)
                throw new Error("pet state conflict");
              return (pet.entries[key] = {
                revision: previous.revision + 1,
                value: payload.value as string | null,
              });
            }
            return structuredClone(pet);
          }
          if (command === "conversation_list_windows") return { revision: 0, windows: [] };
        if (["agent_get_task_snapshots", "conversation_chat_history"].includes(command)) return [];
        if (["conversation_get_view", "conversation_save_view", "conversation_forget_view"].includes(command)) return null;
        if (command === "background_status") return [];
          if (command === "get_data_health")
            return {
              memoryPersistent: true,
              sqlite: { acquisitions: 0, waitMicros: 0, holdMicros: 0 },
              jsonLockAcquisitions: 0,
              jsonLockWaitMicros: 0,
              speechRecognition: true,
              wasmPlugins: true,
            };

          if (command === "get_notification_status")
            return {
              platform: "macos",
              authorization: "authorized",
              alertsEnabled: true,
              soundsEnabled: true,
              alertStyle: "banner",
            };
          if (command === "get_settings") return structuredClone(state);
          if (command === "get_onboarding_status")
            return { required: false, completed: true, version: "1.0" };
          if (command === "soul_get_settings")
            return {
              revision: 1,
              enabled: false,
              paused: false,
              categories: [],
              mood_enabled: false,
              evolution_enabled: false,
              daily_limit: 3,
              cooldown_seconds: 7200,
            };
          if (command === "soul_get_profile")
            return {
              profile_id: "piko",
              schema_version: 2,
              revision: 1,
              default_resource_version: "1",
              locale: "zh-CN",
              user_overrides: {},
              effective: {
                background: "",
                values: [],
                tone: "",
                catchphrases: [],
                forbidden_phrases: [],
                care: "",
                stance: "",
                extra: "",
              },
              writable: true,
              fallback_reason: null,
            };
          if (command === "soul_get_continuity")
            return {
              revision: 1,
              history_enabled: false,
              days: 0,
              nickname: null,
              nickname_options: [],
              milestones: [],
              proposals: [],
              versions: [],
            };
          if (command === "soul_diagnostics")
            return {
              storage: "ready",
              profile_valid: true,
              ledger_readable: true,
            };
          if (command === "update_agent_auto_approve_commands") {
            if (mode === "failure") throw "Settings storage unavailable";
            state.agentAutoApproveCommands = args?.enabled === true;
            return structuredClone(state);
          }
          if (command === "update_ai_settings") {
            if (mode === "failure") throw "Keychain storage unavailable";
            const { apiKey, ...ai } = args!.input!;
            state.ai = ai as typeof state.ai;
            if (mode === "persistent" && typeof apiKey === "string")
              storedKey = apiKey;
            state.hasApiKey = Boolean(storedKey);
            return structuredClone(state);
          }
          if (command === "list_models") {
            if (!storedKey && !args?.input?.apiKey) throw "HTTP 401: Invalid API key";
            return [{ id: "gpt-6-luna" }];
          }
          if (command.startsWith("plugin:"))
            return command.includes("listen") ? 1 : false;
          if (command === "get_focus_state")
            return { phase: "idle", remainingSeconds: 0, todayFocusSeconds: 0 };
          return [];
        },
      };
    },
    { mode },
  );
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置" })
    .click();
  await page.locator("#settings-group-ai > summary").click();
  await expect(page.locator("#settings-group-ai .model-connection-entry strong")).toBeVisible();
}

async function openModelSettings(page: Page) {
  await page.getByRole("button", { name: "模型与 API", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "模型与 API" })).toBeVisible();
}

test("fetches models using a draft key before saving, then reuses the saved credential", async ({ page }) => {
  await installSettingsBackend(page, "persistent");
  await openModelSettings(page);
  await page.getByLabel("API 密钥", { exact: true }).fill("  ui-test-key-not-a-secret  ");
  await page.getByRole("tab", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: /获取模型|刷新模型/ }).click();
  await expect(page.getByText("连接正常", { exact: true })).toBeVisible();
  const beforeSave = await page.evaluate(() => (window as unknown as { __settingsCalls: Array<{ command: string }> }).__settingsCalls);
  expect(beforeSave.some(call => call.command === "update_ai_settings")).toBe(false);
  await page.getByRole("button", { name: "保存并使用", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openModelSettings(page);
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  await page.getByRole("tab", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: "刷新模型", exact: true }).click();
  await expect(page.getByText("连接正常", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __settingsCalls: Array<{ command: string; args: { input?: Record<string, unknown> } }> }).__settingsCalls);
  expect(calls.find(call => call.command === "update_ai_settings")?.args.input).toMatchObject({ apiKey: "ui-test-key-not-a-secret", model: "gpt-6-luna" });
  expect(calls.filter(call => call.command === "list_models").at(-1)?.args.input).toMatchObject({ apiKey: null, useSavedKey: true });
});

test("shows discovery failure when the saved credential is unavailable", async ({ page }) => {
  await installSettingsBackend(page, "lost");
  await openModelSettings(page);
  await page.getByLabel("API 密钥", { exact: true }).fill("ui-test-key-not-a-secret");
  await page.getByRole("tab", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: /获取模型|刷新模型/ }).click();
  await expect(page.getByText("连接正常", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存并使用", exact: true }).click();
  await openModelSettings(page);
  await page.getByRole("tab", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: "刷新模型", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/获取失败：.*API Key 无效或已过期/)).toBeVisible();
});

test("keeps typed credentials and the dialog open if saving fails", async ({ page }) => {
  await installSettingsBackend(page, "failure");
  await openModelSettings(page);
  await page.getByLabel("API 密钥", { exact: true }).fill("ui-test-key-not-a-secret");
  await page.getByRole("button", { name: "保存并使用", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("ui-test-key-not-a-secret");
});
test("command auto approval can be enabled and disabled in settings", async ({
  page,
}) => {
  await installSettingsBackend(page, "persistent");
  await page.locator("#settings-group-system > summary").click();
  const toggle = page.getByRole("checkbox", { name: "始终自动批准命令执行" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  const calls = await page.evaluate(() =>
    (
      window as unknown as {
        __settingsCalls: Array<{ command: string; args: unknown }>;
      }
    ).__settingsCalls.filter(
      (call) => call.command === "update_agent_auto_approve_commands",
    ),
  );
  expect(calls.map((call) => call.args)).toEqual([
    { enabled: true },
    { enabled: false },
  ]);
});

test("failed command permission save keeps automatic approval disabled", async ({
  page,
}) => {
  await installSettingsBackend(page, "failure");
  await page.locator("#settings-group-system > summary").click();
  const toggle = page.getByRole("checkbox", { name: "始终自动批准命令执行" });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
