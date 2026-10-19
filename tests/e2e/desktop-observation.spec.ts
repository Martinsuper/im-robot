import { test, expect, installPanelBackend } from "./support/panel-backend";

test("desktop observation is opt-in and its preferences persist", async ({
  page,
}, testInfo) => {
  await installPanelBackend(page);
  await page.setViewportSize({ width: 1100, height: 1100 });
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();

  await page.locator("#settings-group-notify > summary").click();
  await page.getByText("主动聊天与人格", { exact: true }).click();
  const soul = page.locator('[data-name="soul-settings"]');
  const observation = page.locator(
    '[data-name="desktop-observation-settings"]',
  );
  await expect(
    soul.getByRole("checkbox", { name: "桌面观察", exact: true }),
  ).not.toBeChecked();
  await observation.getByLabel("观察频率").selectOption("active");
  await observation.getByLabel("排除的应用").fill("Safari\n微信");
  await observation.getByRole("button", { name: "保存观察设置" }).click();

  await expect(page.getByText("观察设置已保存", { exact: true })).toBeVisible();
  await soul.getByRole("checkbox", { name: "桌面观察", exact: true }).check();
  await expect(
    soul.getByRole("checkbox", { name: "桌面观察", exact: true }),
  ).toBeChecked();
  await page.reload();
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();

  await page.locator("#settings-group-notify > summary").click();
  await page.getByText("主动聊天与人格", { exact: true }).click();
  await expect(observation.getByLabel("观察频率")).toHaveValue("active");
  await expect(observation.getByLabel("排除的应用")).toHaveValue(
    "Safari\n微信",
  );
  await expect(
    soul.getByRole("checkbox", { name: "桌面观察", exact: true }),
  ).toBeChecked();
  await observation.scrollIntoViewIfNeeded();
  await observation.screenshot({
    path: testInfo.outputPath("desktop-observation.png"),
  });
});
