import { expect, test, type Locator } from "@playwright/test";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/panel-shots";
test.use({ viewport: { width: 400, height: 700 } });

test("panel keeps three main tabs and chat available from each", async ({
  page,
}) => {
  await page.goto("/?view=panel");
  const nav = page.getByRole("navigation", { name: "面板导航" });
  await expect(nav.getByRole("button")).toHaveCount(3);
  for (const name of ["今天", "记录", "设置"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(nav.getByRole("button", { name, exact: true })).toHaveClass(
      /is-active/,
    );
    await expect(
      page.getByRole("button", { name: "收起工作区", exact: true }),
    ).toBeVisible();
  }
});

test("today puts quick add and schedule before optional timers", async ({
  page,
}) => {
  await page.goto("/?view=panel");
  await expect(page.getByLabel("要做什么", { exact: true })).toBeInViewport();
  const timeline = page.getByRole("region", { name: "今天的时间线" });
  await expect(timeline).toBeInViewport();
  await expect(timeline.getByTestId("timeline-item")).not.toHaveCount(0);
  await expect(page.locator(".today-focus-disclosure")).not.toHaveAttribute(
    "open",
    /.*/,
  );
  await expect(
    page.getByRole("button", { name: "25 分钟", exact: true }),
  ).not.toBeVisible();
  await page.locator(".today-focus-disclosure > summary").click();
  await expect(
    page.getByRole("button", { name: "25 分钟", exact: true }),
  ).toBeVisible();
  await page.locator(".today-calendar-tools > summary").click();
  await expect(
    page.getByRole("button", { name: "与系统日历同步" }),
  ).toBeVisible();
});

test("records compose on demand and do not cover memory or chat history", async ({
  page,
}) => {
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "记录" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "搜索记录", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("记录内容", { exact: true })).not.toBeVisible();
  await page.locator(".records-composer > summary").click();
  await expect(page.getByLabel("记录内容", { exact: true })).toBeVisible();
  const sections = page.getByRole("navigation", { name: "记录分区" });
  await sections.getByRole("button", { name: "Piko 记住的" }).click();
  await expect(page.locator(".records-composer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "立即提取", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "反思", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "清除全部", exact: true }),
  ).not.toBeVisible();
  await sections.getByRole("button", { name: "对话历史" }).click();
  await expect(page.locator(".records-composer")).toHaveCount(0);
});

test("settings merges to four closed groups with one complete-backup entry", async ({
  page,
}) => {
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "设置" })
    .click();
  await expect(
    page.locator(
      ".tab--settings > .settings-group > summary > .settings-group__title",
    ),
  ).toHaveText(["日常与外观", "AI 与对话", "提醒与陪伴", "系统与数据"]);
  await expect(page.locator("details.settings-group[open]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存人格", exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText("一起成长的记录", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "导出我的数据", exact: true }),
  ).toHaveCount(0);
  await page.locator("#settings-group-system > summary").click();
  await page.getByText("备份与恢复", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "创建完整备份", exact: true }),
  ).toBeVisible();
});

for (const width of [320, 400, 800]) {
  test(`panel fits ${width}px without horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/?view=panel");
    const nav = page.getByRole("navigation", { name: "面板导航" });
    for (const name of ["今天", "记录", "设置"]) {
      await nav.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".panel-shell")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}

test("captures compact default screens for visual review", async ({ page }) => {
  const ready: Record<string, Locator> = {
    today: page.getByLabel("要做什么", { exact: true }),
    records: page.getByRole("textbox", { name: "搜索记录", exact: true }),
    settings: page
      .locator(
        ".tab--settings > .settings-group > summary > .settings-group__title",
      )
      .first(),
  };
  await page.goto("/?view=panel");
  const nav = page.getByRole("navigation", { name: "面板导航" });
  for (const [name, tab] of [
    ["today", "今天"],
    ["records", "记录"],
    ["settings", "设置"],
  ] as const) {
    await nav.getByRole("button", { name: tab }).click();
    await expect(ready[name]).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: "disabled" });
  }
});

test("workspace returns to the usable chat without navigating away", async ({ page }) => {
  await page.goto("/?view=panel");
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(page).toHaveURL(/view=panel/);
  await expect(
    page.getByLabel("发送给 Piko 的问题", { exact: true }),
  ).toBeVisible();
});
