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

test("chat target and collapsed summaries remain readable at panel width", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  const chat = page.getByRole("button", { name: "收起工作区", exact: true });
  const metrics = await chat.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    fontSize: parseFloat(getComputedStyle(el).fontSize),
  }));
  expect(metrics.height).toBeGreaterThanOrEqual(36);
  expect(metrics.fontSize).toBeGreaterThanOrEqual(13);
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const model = page.locator("#settings-group-ai > summary");
  await expect(model).toContainText("尚未测试连接");
  await expect(model).toContainText("ui-test");
  await expect(model).not.toContainText("已连接");
  await expect(
    page.locator("#settings-group-companion > summary"),
  ).toContainText("感知已开启");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("records expose actions on demand and keyboard dismissal preserves data", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "记录", exact: true })
    .click();
  await page.locator(".records-composer > summary").click();
  await page.getByLabel("记录内容", { exact: true }).fill("面板设计待办");
  await page.getByLabel("记录分类", { exact: true }).selectOption("idea");
  await page.getByRole("button", { name: "记一笔", exact: true }).click();
  const card = page.getByTestId("record-card");
  await expect(
    card.getByRole("button", { name: "删除", exact: true }),
  ).not.toBeVisible();
  const menu = card.locator(".records-card__menu > summary");
  await menu.focus();
  await menu.press("Enter");
  await expect(
    card.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await menu.press("Escape");
  await expect(menu).toBeFocused();
  await expect(
    card.getByRole("button", { name: "删除", exact: true }),
  ).not.toBeVisible();
  expect(await callsFor(page, "delete_memo")).toHaveLength(0);
  await expect(
    card
      .locator(".records-card__meta .records-chip")
      .filter({ hasText: "想法" }),
  ).toHaveCount(0);
});
