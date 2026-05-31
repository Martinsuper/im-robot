import { expect, test } from "@playwright/test";

test("pet preview exposes companion actions", async ({ page }) => {
  await page.goto("/?view=pet");
  await expect(page.getByRole("button", { name: "对话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "休息" })).toBeVisible();
  await expect(page.getByRole("button", { name: "面板" })).toBeVisible();
});

test("bubble preview exposes text, file and screenshot entry points", async ({ page }) => {
  await page.goto("/?view=bubble");
  await expect(page.getByLabel("发送给 Piko 的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "截图提问" })).toBeVisible();
  await expect(page.getByRole("button", { name: "朗读回复" })).toBeVisible();
});

test("panel preview exposes settings and network update entry point", async ({ page }) => {
  await page.goto("/?view=panel");
  await expect(page.getByRole("button", { name: "精灵", exact: true })).toHaveClass(/is-active/);
  await page.getByRole("button", { name: "关于" }).click();
  await expect(page.getByText("权限中心")).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeVisible();
  await expect(page.getByText("截图时按需申请")).toBeVisible();
  await page.getByRole("button", { name: "提醒" }).click();
  await expect(page.getByLabel("重复规则")).toHaveValue("none");
});

test("capture preview exposes selection controls", async ({ page }) => {
  await page.goto("/?view=capture");
  await expect(page.getByText("拖动框选截图区域，确认后才会读取屏幕内容")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认截图" })).toBeDisabled();
  await page.mouse.move(80, 90);
  await page.mouse.down();
  await page.mouse.move(280, 240);
  await page.mouse.up();
  await expect(page.getByText("截图区域已选择")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认截图" })).toBeEnabled();
  await expect(page.getByText("200 × 150 · 点击右键确认")).toBeVisible();
  await expect(page.locator(".capture-actions")).toHaveCSS("bottom", "52px");
  await page.mouse.click(360, 260, { button: "right" });
  await expect(page.getByText("截图区域已选择")).toBeVisible();
});
