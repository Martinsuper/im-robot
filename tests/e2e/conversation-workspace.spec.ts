import { expect, test } from "@playwright/test";

test("menu navigates without replacing chat or panel drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/?view=bubble");
  const prompt = page.getByLabel("发送给 Piko 的问题");
  await prompt.fill("还没发送的草稿");
  await page.getByRole("button", { name: "主面板菜单" }).click();
  await expect(page.getByRole("menu", { name: "工作区" })).toBeVisible();
  await expect(page.getByRole("region", { name: "主面板工作区" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "记录" }).click();
  await expect(prompt).toBeVisible();
  const nav = page.getByRole("navigation", { name: "面板导航" });
  await expect(prompt).toHaveValue("还没发送的草稿");
  await nav.getByRole("button", { name: "今天", exact: true }).click();
  const chatBox = await page.locator(".bubble-shell").boundingBox();
  const panelBox = await page.locator(".conversation-workspace__panel").boundingBox();
  expect(panelBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width);
  await nav.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("navigation", { name: "记录分区" }).getByRole("button", { name: "对话历史" }).click();
  await expect(page.locator(".records-history__detail")).not.toBeVisible();
  await page.getByRole("list", { name: "最近对话列表" }).getByRole("button").first().click();
  await expect(page.locator(".records-history__detail")).toBeVisible();
  await page.getByRole("button", { name: "返回记录列表" }).click();
  await expect(page.getByRole("list", { name: "最近对话列表" })).toBeVisible();
  const search = page.getByRole("textbox", { name: "搜索记录", exact: true });
  await search.fill("保留筛选");
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await nav.getByRole("button", { name: "记录", exact: true }).click();
  await expect(search).toHaveValue("保留筛选");
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(search).not.toBeVisible();
  await page.getByRole("button", { name: "打开主面板", exact: true }).click();
  await expect(search).toHaveValue("保留筛选");
  await expect(prompt).toHaveValue("还没发送的草稿");
});

test("small windows return to the same chat and remember the last section", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 });
  await page.goto("/?view=bubble");
  const prompt = page.getByLabel("发送给 Piko 的问题");
  await prompt.fill("窄屏草稿");
  await page.getByRole("button", { name: "主面板菜单" }).click();
  await page.getByRole("menuitem", { name: "设置" }).click();
  await expect(prompt).not.toBeVisible();
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(prompt).toHaveValue("窄屏草稿");
  await page.reload();
  await page.getByRole("button", { name: "打开主面板", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "设置", exact: true })).toHaveClass(/is-active/);
});

test("Escape and outside clicks dismiss only the navigation menu", async ({ page }) => {
  await page.goto("/?view=bubble");
  const trigger = page.getByRole("button", { name: "主面板菜单" });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await page.getByLabel("发送给 Piko 的问题").click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
