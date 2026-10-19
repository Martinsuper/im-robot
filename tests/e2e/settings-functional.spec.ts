import {
  test,
  expect,
  installPanelBackend,
  callsFor,
} from "./support/panel-backend";

test.use({
  viewport: { width: 400, height: 700 },
  timezoneId: "Asia/Shanghai",
});
async function openSettings(page: import("@playwright/test").Page) {
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.locator("#settings-group-companion > summary").click();
  await page.locator("#settings-group-notify > summary").click();
  await page.getByText("主动聊天与人格", { exact: true }).click();
  await expect(page.getByLabel("精灵名称", { exact: true })).toBeVisible();
}

test("debounced companion preferences persist together after reload", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await openSettings(page);
  await page.getByLabel("精灵名称", { exact: true }).fill("UI伙伴");
  await page
    .getByRole("combobox", { name: "主题色", exact: true })
    .selectOption("blue");
  await expect
    .poll(async () => (await callsFor(page, "update_preferences")).length)
    .toBeGreaterThan(0);
  const last = (await callsFor(page, "update_preferences")).at(-1)!;
  expect(last.args.input).toMatchObject({
    companionName: "UI伙伴",
    theme: "blue",
    sensingPaused: false,
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.locator("#settings-group-companion > summary").click();
  await page.locator("#settings-group-notify > summary").click();
  await page.getByText("主动聊天与人格", { exact: true }).click();
  await expect(page.getByLabel("精灵名称", { exact: true })).toHaveValue(
    "UI伙伴",
  );
  await expect(
    page.getByRole("combobox", { name: "主题色", exact: true }),
  ).toHaveValue("blue");
});

test("native visibility controls call the corresponding command once", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await openSettings(page);
  await page.getByRole("button", { name: "隐藏伙伴", exact: true }).click();
  await expect
    .poll(async () => (await callsFor(page, "hide_pet")).length)
    .toBe(1);
  await page.getByRole("button", { name: "显示伙伴", exact: true }).click();
  expect(await callsFor(page, "show_pet")).toHaveLength(1);
});

test("data cleanup requires explicit confirmation and cancel writes nothing", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await openSettings(page);
  await page.locator("#settings-group-system > summary").click();
  await page
    .getByRole("button", { name: "清空我的数据…", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "确认清空", exact: true }),
  ).toBeVisible();
  expect(await callsFor(page, "clear_my_data")).toHaveLength(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "清空我的数据…", exact: true }),
  ).toBeVisible();
  expect(await callsFor(page, "clear_my_data")).toHaveLength(0);
});

test("soul toggles and role save pass revision and locale through IPC", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await openSettings(page);
  const soul = page.locator('[data-name="soul-settings"]');
  await soul.getByLabel("启用主动消息", { exact: true }).check();
  await expect(soul.getByLabel("启用主动消息", { exact: true })).toBeChecked();
  expect(
    (await callsFor(page, "soul_update_settings"))[0].args.input,
  ).toMatchObject({ expected_revision: 7, enabled: true });
  await soul.getByLabel("语气", { exact: true }).fill("简洁、直接");
  await soul.getByRole("button", { name: "保存人格", exact: true }).click();
  await expect(page.getByText("人格已保存。", { exact: true })).toBeVisible();
  expect(
    (await callsFor(page, "soul_update_profile"))[0].args.input,
  ).toMatchObject({
    expected_revision: 4,
    locale: "zh-CN",
    user_overrides: { tone: "简洁、直接" },
  });
});

test("failed soul update leaves its switch unchanged", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    failures: { soul_update_settings: "测试版本冲突" },
  });
  await openSettings(page);
  const toggle = page
    .locator('[data-name="soul-settings"]')
    .getByLabel("启用主动消息", { exact: true });
  await toggle.click();
  await expect(page.getByText("测试版本冲突", { exact: true })).toBeVisible();
  await expect(toggle).not.toBeChecked();
});

test("native permission query failures are contained and visible", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    failures: {
      "plugin:autostart|is_enabled": "测试自启不可用",
      get_notification_status: "测试通知不可用",
      screen_capture_permission_status: "测试截图权限不可用",
      list_external_plugins: "测试插件目录不可用",
    },
  });
  await openSettings(page);
  await expect(page.getByText(/测试自启不可用/)).toBeVisible();
  await page.locator("#settings-group-system > summary").click();
  await page.getByText("关于与更新", { exact: true }).click();
  await expect(
    page
      .locator("#settings-group-system")
      .getByText("读取失败", { exact: true }),
  ).toHaveCount(2);
});
