import { test, expect, installPanelBackend, callsFor } from "./support/panel-backend";
test.use({ viewport: { width: 400, height: 760 } });
test("Passport pairing controls work in the narrow settings workspace", async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await page.locator("#settings-group-system > summary").click();
  const device = page.getByRole("region", { name: "Piko Passport 设备" });
  await expect(device).toBeVisible();
  await device.getByRole("checkbox", { name: "开启局域网设备连接" }).check();
  await device.getByRole("button", { name: "生成手动配对码" }).click();
  await expect(device.getByText("1234abcd", { exact: true })).toBeVisible();
  await expect(device.getByText(/在设备的「连接」页短按确认键即可连接/)).toBeVisible();
  await device.getByRole("checkbox").uncheck();
  await expect(device.getByText("1234abcd", { exact: true })).toHaveCount(0);
  expect(await callsFor(page, "start_device_bridge")).toHaveLength(1);
  expect(await callsFor(page, "stop_device_bridge")).toHaveLength(1);
});
