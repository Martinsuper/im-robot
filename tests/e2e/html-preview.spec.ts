import { expect, test } from "@playwright/test";

test("HTML preview renders scripts and options dismiss outside, on Escape and inside iframe", async ({ page }, testInfo) => {
  await page.goto("/?view=bubble");
  await page.getByLabel("发送给 Piko 的问题").fill('```html\n<h1>Piko Preview OK</h1><button onclick="this.textContent=\'Script OK\'">Test script</button>\n```');
  await page.getByRole("button", { name: "发送消息" }).click();
  const menu = page.locator(".inline-more-menu");
  const summary = page.getByLabel("更多操作");
  await summary.click();
  await expect(menu).toHaveAttribute("open", "");
  await page.getByLabel("发送给 Piko 的问题").click();
  await expect(menu).not.toHaveAttribute("open", "");
  await summary.click();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await summary.click();
  await menu.getByRole("button", { name: "HTML 预览" }).click();
  await expect(menu).not.toHaveAttribute("open", "");
  const frame = page.frameLocator(".html-preview-frame");
  await expect(frame.getByRole("heading", { name: "Piko Preview OK" })).toBeVisible();
  await page.getByRole("checkbox").check();
  await frame.getByRole("button", { name: "Test script" }).click();
  await expect(frame.getByRole("button", { name: "Script OK" })).toBeVisible();
  await summary.click();
  await frame.getByRole("heading").click();
  await expect(menu).not.toHaveAttribute("open", "");
  await page.screenshot({ path: testInfo.outputPath("html-preview.png"), fullPage: true });
});

async function showPreview(page: import("@playwright/test").Page) {
  await page.goto("/?view=bubble");
  await page.getByLabel("发送给 Piko 的问题").fill('```html\n<h1>Resizable preview</h1><button onclick="this.textContent=\'Detached script OK\'">Run script</button>\n```');
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByLabel("更多操作").click();
  await page.locator(".inline-more-menu").getByRole("button", { name: "HTML 预览" }).click();
  await expect(page.frameLocator(".html-preview-frame").getByRole("heading")).toBeVisible();
  await page.getByRole("checkbox").check();
}

test("preview resizes from its corner and opens an independent sandboxed window", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await showPreview(page);
  const card = page.locator(".html-preview-card");
  await card.scrollIntoViewIfNeeded();
  const before = (await card.boundingBox())!;
  expect(before.height).toBeGreaterThanOrEqual(400);
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 103, before.y + before.height + 97, { steps: 10 });
  await page.mouse.up();
  const after = (await card.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 50);
  expect(after.width).toBeLessThan(before.width - 50);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "独立窗口打开" }).click();
  const popup = await popupPromise;
  await expect(popup.frameLocator("iframe").getByRole("heading", { name: "Resizable preview" })).toBeVisible();
  await expect(popup.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await popup.frameLocator("iframe").getByRole("button", { name: "Run script" }).click();
  await expect(popup.frameLocator("iframe").getByRole("button", { name: "Detached script OK" })).toBeVisible();
  await page.reload();
  await expect(popup.frameLocator("iframe").getByRole("heading")).toBeVisible();
  await popup.screenshot({ path: testInfo.outputPath("detached-preview.png") });
  await popup.close();
});

test("dragging the preview title outside the card opens a new window", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await showPreview(page);
  const card = (await page.locator(".html-preview-card").boundingBox())!;
  const header = (await page.locator(".html-preview-card__header").boundingBox())!;
  const popupPromise = page.waitForEvent("popup");
  await page.mouse.move(header.x + 35, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width + 50, header.y + header.height / 2, { steps: 12 });
  await page.mouse.up();
  const popup = await popupPromise;
  await expect(popup.frameLocator("iframe").getByRole("heading", { name: "Resizable preview" })).toBeVisible();
  await popup.close();
});

test("HTML remains previewable after becoming history and respects the preview preference", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await showPreview(page);
  await page.getByLabel("发送给 Piko 的问题").fill("继续下一轮");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("这是浏览器预览回复：继续下一轮", { exact: true })).toBeVisible();
  const history = page.locator(".bubble-thread__history-item").first();
  await expect(history.locator("iframe")).toHaveCount(0);
  await history.locator(".bubble-thread__history-toggle").click();
  await expect(history.frameLocator("iframe").getByRole("heading", { name: "Resizable preview" })).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await history.getByRole("button", { name: "独立窗口打开" }).click();
  const popup = await popupPromise;
  await expect(popup.frameLocator("iframe").getByRole("heading", { name: "Resizable preview" })).toBeVisible();
  await popup.close();
  await page.getByLabel("更多操作").click();
  await page.locator(".inline-more-menu").getByRole("button", { name: "HTML 预览" }).click();
  await expect(history.locator("iframe")).toHaveCount(0);
  await expect(history.locator("code")).toContainText("<h1>Resizable preview</h1>");
});
