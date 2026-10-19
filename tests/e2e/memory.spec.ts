import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 400, height: 700 } });
test("memory center exposes extraction settings and candidate review at panel width", async ({
  page,
}) => {
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "记录" })
    .click();
  await page.getByRole("button", { name: "Piko 记住的", exact: true }).click();
  const settings = page.getByRole("region", { name: "自动提取记忆" });
  await expect(settings).toBeVisible();
  await settings.getByText("自动提取设置", { exact: true }).click();
  await expect(settings.getByRole("checkbox")).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "立即提取" }),
  ).toBeDisabled();
  await expect(settings.getByLabel("提取间隔")).toHaveValue("30");
  await expect(settings).toContainText("请在桌面应用中设置自动提取。");
  await page.getByRole("button", { name: /待确认/ }).click();
  await expect(page.getByText("没有待确认的记忆")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/memory-extraction-panel.png",
    fullPage: true,
  });
});
