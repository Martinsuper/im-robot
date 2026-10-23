import { test, expect, installPanelBackend } from "./support/panel-backend";

test.use({ viewport: { width: 1440, height: 1024 } });

test("calendar selection creates an item on that day and updates its count after reload", async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  const calendar = page.getByRole("region", { name: "日历", exact: true });
  await calendar.getByRole("button", { name: "2026年10月19日，0件事", exact: true }).click();
  await page.locator(".today-add-disclosure > summary").click();
  const form = page.getByRole("region", { name: "快速添加" });
  await form.getByLabel("要做什么", { exact: true }).fill("日历选日自动化提醒");
  await expect(form.getByLabel("时间", { exact: true })).toHaveValue("2026-10-19T09:00");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  await expect(form.getByLabel("时间", { exact: true })).toHaveValue("2026-10-19T09:00");
  await expect(calendar.getByRole("button", { name: "2026年10月19日，1件事", exact: true })).toHaveAttribute("aria-pressed", "true");
  const agenda = page.getByRole("region", { name: "今天的时间线" });
  await expect(agenda.getByTestId("timeline-item")).toContainText("日历选日自动化提醒");
  await calendar.getByRole("button", { name: "2026年10月18日，0件事", exact: true }).click();
  await expect(agenda.getByTestId("timeline-item")).toHaveCount(0);
  await page.reload();
  await calendar.getByRole("button", { name: "2026年10月19日，1件事", exact: true }).click();
  await expect(agenda.getByTestId("timeline-item")).toContainText("日历选日自动化提醒");
});

test("month navigation crosses a year and today restores the selected date", async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  const calendar = page.getByRole("region", { name: "日历", exact: true });
  for (let i = 0; i < 3; i++) await calendar.getByRole("button", { name: "下个月", exact: true }).click();
  await expect(calendar.getByRole("heading", { name: "2027 年 1 月", exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "2027年1月5日，0件事", exact: true }).click();
  await expect(page.getByRole("region", { name: "今天的时间线" })).toContainText("1月5日");
  await calendar.getByRole("button", { name: "回到今天", exact: true }).click();
  await expect(calendar.getByRole("heading", { name: "2026 年 10 月", exact: true })).toBeVisible();
  await expect(calendar.getByRole("button", { name: "2026年10月18日，0件事", exact: true })).toHaveAttribute("aria-pressed", "true");
});
