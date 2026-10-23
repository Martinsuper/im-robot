import { expect, test, type Locator, type Page } from "@playwright/test";

async function clickAndExpectPopupClose(popup: Page, control: Locator) {
  // window.close() may destroy the target before Playwright acknowledges the click.
  // Require the close event, and keep asserting restored state in the parent page.
  await Promise.all([
    popup.waitForEvent("close"),
    control.click().catch((error: unknown) => {
      if (!popup.isClosed() || !String(error).includes("Target page, context or browser has been closed")) {
        throw error;
      }
    }),
  ]);
}

test("background conversations finish independently and retain their drafts", async ({ page }) => {
  await page.goto("/?view=bubble");
  const panel = page.getByRole("tabpanel");
  const input = panel.getByLabel("发送给 Piko 的问题");
  await input.fill("第一项独立任务");
  await input.press("Enter");
  // Starting a conversation remains available while the first reply is pending.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(input).toHaveValue("");
  await input.fill("第二项独立任务");
  await input.press("Enter");
  await page.getByRole("tab").first().click();
  await expect(panel.getByRole("region", { name: "对话内容" }).getByText("这是浏览器预览回复：第一项独立任务", { exact: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "对话内容" }).getByText("这是浏览器预览回复：第二项独立任务", { exact: true })).toHaveCount(0);
  await input.fill("第一项未发送草稿");
  await page.getByRole("tab").nth(1).click();
  await expect(panel.getByRole("region", { name: "对话内容" }).getByText("这是浏览器预览回复：第二项独立任务", { exact: true })).toBeVisible();
  await input.fill("第二项未发送草稿");
  await page.getByRole("tab").first().click();
  await expect(input).toHaveValue("第一项未发送草稿");
  await page.getByRole("tab").nth(1).click();
  await expect(input).toHaveValue("第二项未发送草稿");
  await page.getByRole("button", { name: "关闭会话：第一项独立任务" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(input).toHaveValue("第二项未发送草稿");
});

test("tabs restore after reload and keyboard navigation selects a mounted conversation", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 });
  await page.goto("/?view=bubble");
  await page.getByRole("button", { name: "新建会话标签页" }).click();
  await page.getByRole("button", { name: "新建会话标签页" }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(3);
  const last = page.getByRole("tab").last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await last.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});

test("a detached window takes ownership and returns its draft and conversation", async ({ page }) => {
  await page.goto("/?view=bubble");
  const input = page.getByRole("tabpanel").getByLabel("发送给 Piko 的问题");
  await input.fill("可转移的会话");
  await input.press("Enter");
  await expect(page.getByText("这是浏览器预览回复：可转移的会话", { exact: true })).toBeVisible();
  await input.fill("弹出前的草稿");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "在独立窗口打开" }).click();
  const popup = await popupPromise;
  await expect(page.getByText("此会话已在独立窗口打开，后台任务会继续执行。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("发送给 Piko 的问题")).toHaveCount(0);
  const popupInput = popup.getByRole("tabpanel").getByLabel("发送给 Piko 的问题");
  await expect(popupInput).toHaveValue("弹出前的草稿");
  await expect(popup.getByText("这是浏览器预览回复：可转移的会话", { exact: true })).toBeVisible();
  await popupInput.fill("独立窗口编辑的草稿");
  await popup.reload();
  await expect(popupInput).toHaveValue("独立窗口编辑的草稿");
  await clickAndExpectPopupClose(popup, popup.getByRole("button", { name: "关闭会话：可转移的会话", exact: true }));
  await expect(input).toHaveValue("独立窗口编辑的草稿");
  await expect(page.getByText("这是浏览器预览回复：可转移的会话", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("a task can be handed off while its reply is pending", async ({ page }) => {
  await page.goto("/?view=bubble");
  const input = page.getByRole("tabpanel").getByLabel("发送给 Piko 的问题");
  await input.fill("运行中转移");
  await input.press("Enter");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "在独立窗口打开" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("这是浏览器预览回复：运行中转移", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建会话标签页" }).click();
  await page.getByRole("tabpanel").getByLabel("发送给 Piko 的问题").fill("主窗口中的独立草稿");
  await clickAndExpectPopupClose(popup, popup.getByRole("button", { name: "返回主窗口", exact: true }));
  await page.getByRole("tab").first().click();
  await expect(page.getByText("这是浏览器预览回复：运行中转移", { exact: true })).toBeVisible();
});
