import {
  test,
  expect,
  installPanelBackend,
  callsFor,
} from "./support/panel-backend";
test.use({ viewport: { width: 400, height: 700 } });
async function openNotifications(page: import("@playwright/test").Page) {
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.locator("#settings-group-notify > summary").click();
  await expect(page.getByRole("button", { name: "发送测试通知", exact: true })).toBeHidden();
  await page.getByText("通知排查", { exact: true }).click();
}
for (const [authorization, label] of [
  ["denied", "系统已拒绝"],
  ["notDetermined", "尚未授权"],
  ["provisional", "仅静默通知"],
]) {
  test(`notification status reflects native ${authorization} instead of legacy granted`, async ({
    healthyPage: page,
  }) => {
    await installPanelBackend(page, { notificationStatus: { authorization } });
    await openNotifications(page);
    await expect(
      page.locator("#settings-group-notify").getByText(label, { exact: true }),
    ).toBeVisible();
    expect(
      await callsFor(page, "request_notification_permission"),
    ).toHaveLength(0);
    expect(
      await callsFor(page, "plugin:notification|is_permission_granted"),
    ).toHaveLength(0);
    await page
      .getByRole("button", { name: "打开系统通知设置", exact: true })
      .click();
    expect(await callsFor(page, "open_notification_settings")).toHaveLength(1);
  });
}

test("authorized but disabled banners are reported separately", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    notificationStatus: {
      authorization: "authorized",
      alertsEnabled: true,
      alertStyle: "none",
    },
  });
  await openNotifications(page);
  await expect(
    page
      .locator("#settings-group-notify")
      .getByText("已授权，横幅已关闭", { exact: true }),
  ).toBeVisible();
});

test("permission is requested only on explicit action and status refreshes", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    notificationStatus: { authorization: "notDetermined" },
  });
  await openNotifications(page);
  expect(await callsFor(page, "request_notification_permission")).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "去开启", exact: true }).click();
  await expect(
    page.locator("#settings-group-notify").getByText("已授权", { exact: true }),
  ).toBeVisible();
  expect(await callsFor(page, "request_notification_permission")).toHaveLength(
    1,
  );
});

test("test notification reports submission and queries real status afterwards", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await openNotifications(page);
  const before = (await callsFor(page, "get_notification_status")).length;
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click();
  await expect(
    page.getByText("测试通知已提交，请检查屏幕右上角或通知中心。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await callsFor(page, "send_test_notification")).toHaveLength(1);
  expect(
    (await callsFor(page, "get_notification_status")).length,
  ).toBeGreaterThan(before);
});

test("native submission failure is visible and the test button can be retried", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    failures: { send_test_notification: "系统通知被拒绝" },
  });
  await openNotifications(page);
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click();
  await expect(page.getByText("系统通知被拒绝", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送测试通知", exact: true }),
  ).toBeEnabled();
});
