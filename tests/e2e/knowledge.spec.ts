import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 400, height: 760 } });
test("knowledge library is readable at desktop panel width", async ({ page }) => {
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "记录" }).click();
  await page.getByRole("button", { name: "Piko 记住的", exact: true }).click();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已导入文档（0）" })).toBeVisible();
  await expect(page.getByText("请在桌面应用中导入资料和配置语义检索。")).toBeVisible();
  await expect(page.getByRole("button", { name: "导入文件", exact: true })).toBeDisabled();
  await page.getByText("语义检索设置", { exact: true }).click();
  await expect(page.getByLabel("Embedding 完整接口地址")).toHaveValue("http://localhost:11434/v1/embeddings");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/knowledge-panel.png", fullPage: true });
});
