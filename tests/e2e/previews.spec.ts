import { expect, test } from "@playwright/test";

test("pet preview renders the companion", async ({ page }) => {
  await page.goto("/?view=pet");
  await expect(page.locator(".pet-stage")).toBeVisible();
});

test("bubble preview exposes text, file and screenshot entry points", async ({ page }) => {
  await page.goto("/?view=bubble");
  await expect(page.getByLabel("发送给 Piko 的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "截图提问" })).toBeVisible();
  // 回复工具条（朗读 / 保存）只在已经有一条回复时才渲染，而预览是空态，
  // 所以这里不断言它。该部分的覆盖等 R2 拆分 BubbleWindow、能把一条回复
  // 作为初始状态注入之后再补。
});

test("panel preview renders the three-tab shell", async ({ page }) => {
  await page.goto("/?view=panel");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: "今天" })).toHaveClass(/is-active/);
  // 各 Tab 的细节断言在 panel-tabs.spec.ts 里，这里只确认外壳可用。
  await nav.getByRole("button", { name: "设置" }).click();
  await expect(nav.getByRole("button", { name: "设置" })).toHaveClass(/is-active/);
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
