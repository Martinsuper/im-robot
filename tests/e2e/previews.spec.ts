import { expect, test } from "@playwright/test";

// 面板/气泡的选项标签已接入 i18n（app.tab.* 等在 en-US.json 有现成翻译），
// 浏览器默认 locale 是 en-US 会把 tab 渲染成英文，固定 zh-CN 保证中文选择器稳定。
test.use({ locale: "zh-CN" });

test("pet preview exposes companion actions", async ({ page }) => {
  await page.goto("/?view=pet");
  await expect(page.locator(".pet-clock")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByRole("button", { name: "对话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "休息" })).toBeVisible();
  await expect(page.getByRole("button", { name: "面板" })).toBeVisible();
});

test("bubble preview exposes text, file and screenshot entry points", async ({ page }) => {
  await page.goto("/?view=bubble");
  await expect(page.getByLabel("发送给 Piko 的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "截图提问" })).toBeVisible();

  // 行内工具栏（朗读/保存）在有回复内容后才出现：预览模式先发送一条消息
  await page.getByLabel("发送给 Piko 的问题").fill("你好");
  await page.locator("form.prompt-form").getByRole("button").last().click();
  await expect(page.getByText("这是浏览器预览回复：你好")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: "朗读回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存回复" })).toBeVisible();
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
  await expect(page.getByText("今日专注")).toBeVisible();
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
