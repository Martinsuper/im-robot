import { expect, test, type Locator } from "@playwright/test";

/**
 * R1 的 3 Tab 信息架构验收。
 *
 * 这里同时承担一个额外职责：**给 coordinator 提供视觉验证通道**。
 * 本机的 `screencapture` 被 TCC（屏幕录制权限）拒绝，无法给真实窗口截图；
 * 而 Playwright 走的是 Chromium 自己的截图接口，不受该限制。
 * 因此每个 Tab 都会落一张 PNG 到 SHOT_DIR（默认 /tmp/panel-shots），
 * 供人（或 agent）直接查看布局是否正确。
 */
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/panel-shots";

// 面板窗口的真实尺寸是 400x700（见 src-tauri/tauri.conf.json）。
// 用默认的 1280x720 截图会看不出真实的换行与挤压问题。
test.use({ viewport: { width: 400, height: 700 } });

test("panel exposes exactly the three top-level tabs", async ({ page }) => {
  await page.goto("/?view=panel");

  const nav = page.getByRole("navigation", { name: "面板导航" });
  await expect(nav.getByRole("button")).toHaveCount(3);
  await expect(nav.getByRole("button", { name: "今天" })).toHaveClass(/is-active/);
  // IA-7：面板顶部常驻的 4 项总览已移除
  await expect(page.locator(".panel-overview")).toHaveCount(0);

  await nav.getByRole("button", { name: "记录" }).click();
  await expect(nav.getByRole("button", { name: "记录" })).toHaveClass(/is-active/);
  await expect(page.getByLabel("记录标题")).toBeVisible();

  await nav.getByRole("button", { name: "设置" }).click();
  await expect(nav.getByRole("button", { name: "设置" })).toHaveClass(/is-active/);
});

test("today shows the greeting, focus card, quick add and one timeline", async ({ page }) => {
  await page.goto("/?view=panel");

  await expect(page.getByRole("heading", { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "专注与休息" })).toBeVisible();
  await expect(page.getByRole("button", { name: "25 分钟" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始专注" })).toHaveCount(0); // 时长按钮本身就是入口
  await expect(page.getByLabel("要做什么")).toBeVisible();

  // 时间线：提醒与日程在同一条线上，用 kind 区分
  const timeline = page.getByRole("region", { name: "今天的时间线" });
  await expect(timeline.getByTestId("timeline-item")).not.toHaveCount(0);
  await expect(timeline.locator('[data-kind="reminder"]')).not.toHaveCount(0);
  await expect(timeline.locator('[data-kind="event"]')).not.toHaveCount(0);

  // 演示数据里 14:00-15:00 与 14:30-15:30 重叠
  await expect(page.getByText(/有 \d+ 处时间冲突/)).toBeVisible();

  // 03 §7：系统日历同步收敛成一个入口，导出放在同一处，不再有三个并排按钮
  await expect(page.getByRole("button", { name: "与系统日历同步" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 iCalendar" })).toBeVisible();

});

test("records merges memos and what Piko remembers", async ({ page }) => {
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "记录" }).click();

  await expect(page.getByRole("region", { name: "记录入口" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "记录分区" })).toBeVisible();
  await expect(page.getByRole("button", { name: "我的记录" })).toHaveClass(/is-active/);

  await page.getByRole("button", { name: "Piko 记住的" }).click();
  await expect(page.getByRole("button", { name: "Piko 记住的" })).toHaveClass(/is-active/);

});

test("settings is grouped into companion / model / notify / system / soul / about / advanced", async ({ page }) => {
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "设置" }).click();

  for (const title of ["伙伴", "对话与模型", "提醒与免打扰", "系统与隐私", "灵魂系统", "关于", "高级"]) {
    await expect(page.locator(".settings-group__title", { hasText: title }).first()).toBeVisible();
  }

  // 05 §9：高级组默认折叠且位于最后
  const groups = page.locator("details.settings-group");
  await expect(groups).toHaveCount(7);
  await expect(groups.last()).not.toHaveAttribute("open", /.*/);

  // 系统与隐私组里要有「导出我的数据」（05 §4.4）
  await expect(page.locator("#settings-group-system")).not.toHaveAttribute("open", /.*/);
  await page.locator("#settings-group-system > summary").click();
  await expect(page.getByRole("button", { name: "导出我的数据" })).toBeVisible();

});

/**
 * 视觉验证通道。
 *
 * `.panel-workspace` 是内部滚动容器，`fullPage` 截不到滚动区外的内容。
 * 这里把视口加高到能容纳整页（宽度仍是真实的 400），从而截到完整布局。
 */
test("captures full-height screenshots for visual review", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 3600 });
  const nav = page.getByRole("navigation", { name: "面板导航" });

  // 面板是 lazy 加载的，不等到真实内容出现就会截到「加载中…」
  const ready: Record<string, Locator> = {
    today: page.getByLabel("要做什么"),
    records: page.getByLabel("记录标题"),
    settings: page.locator(".settings-group__title").first(),
  };

  for (const [name, tab] of [["today", "今天"], ["records", "记录"], ["settings", "设置"]] as const) {
    await page.goto("/?view=panel");
    await expect(page.locator(".panel-shell")).toBeVisible();
    if (tab !== "今天") await nav.getByRole("button", { name: tab }).click();
    await expect(ready[name]).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  }
});
