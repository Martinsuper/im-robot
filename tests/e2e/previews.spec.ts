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

test("panel preview exposes settings and network update entry point", async ({ page }) => {
  await page.goto("/?view=panel");
  await expect(page.getByRole("button", { name: "精灵", exact: true })).toHaveClass(/is-active/);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByLabel("服务类型").selectOption("anthropic");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.anthropic.com/v1");
  await expect(page.getByLabel("Model")).toHaveValue("claude-sonnet-4-6");
  await page.getByRole("button", { name: "关于" }).click();
  await expect(page.getByText("权限中心")).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeVisible();
  await expect(page.getByText("截图时按需申请")).toBeVisible();
  await page.getByRole("button", { name: "提醒" }).click();
  await expect(page.getByLabel("重复规则")).toHaveValue("none");
  await expect(page.getByRole("heading", { name: "专注模式" })).toBeVisible();
  await expect(page.getByLabel("专注时长")).toHaveValue("25");
  await page.getByRole("button", { name: "历史" }).click();
  // 「今日专注」在面板总览（常驻，IA-7）与历史分区里各出现一次，必须限定分区，
  // 否则 Playwright 会报 strict mode 冲突。IA-7 的移除属于 R1。
  await expect(page.locator(".panel-section--history").getByText("今日专注")).toBeVisible();
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
