import {
  test,
  expect,
  installPanelBackend,
  callsFor,
} from "./support/panel-backend";

test.use({
  viewport: { width: 400, height: 700 },
  timezoneId: "Asia/Shanghai",
});
async function openMemory(page: import("@playwright/test").Page) {
  await installPanelBackend(page, { memory: true });
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "面板导航" })
    .getByRole("button", { name: "记录", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "记录分区" })
    .getByRole("button", { name: "Piko 记住的", exact: true })
    .click();
  await expect(
    page
      .locator(".memory-list")
      .getByRole("heading", { name: "自动化记忆", exact: true }),
  ).toBeVisible();
}

test("memory pin, unpin and delete refresh without accidentally opening details", async ({
  healthyPage: page,
}) => {
  await openMemory(page);
  const card = page.locator(".memory-list .memory-card");
  await card.getByRole("button", { name: "置顶", exact: true }).click();
  await expect(card).toHaveClass(/memory-card--pinned/);
  await expect(page.locator(".memory-detail-overlay")).toHaveCount(0);
  await card.getByRole("button", { name: "取消置顶", exact: true }).click();
  await expect(card).not.toHaveClass(/memory-card--pinned/);
  await card.getByRole("button", { name: "删除", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".memory-detail-overlay")).toHaveCount(0);
  for (const command of ["pin_memory", "unpin_memory", "delete_memory"])
    expect((await callsFor(page, command))[0].args.id).toBe("memory-1");
});

for (const approve of [true, false])
  test(`memory candidate ${approve ? "approval" : "rejection"} removes it from the queue`, async ({
    healthyPage: page,
  }) => {
    await openMemory(page);
    await page.getByRole("button", { name: "待确认 (1)", exact: true }).click();
    const card = page
      .locator(".memory-card--pending")
      .filter({ hasText: "候选偏好" });
    await card
      .getByRole("button", {
        name: approve ? "✓ 确认记住" : "✕ 忽略",
        exact: true,
      })
      .click();
    await expect(card).toHaveCount(0);
    const command = approve
      ? "apply_memory_candidates"
      : "reject_memory_candidate";
    expect((await callsFor(page, command))[0].args).toEqual(
      approve
        ? { input: { candidateId: "candidate-1", confirmed: true } }
        : { candidateId: "candidate-1" },
    );
  });

test("memory extraction toggle, interval and manual extraction use the same stored status", async ({
  healthyPage: page,
}) => {
  await openMemory(page);
  const controls = page.getByRole("region", {
    name: "自动提取记忆",
    exact: true,
  });
  await controls.getByText("自动提取设置", { exact: true }).click();
  await controls.getByLabel("定期从对话提取记忆", { exact: true }).check();
  await controls.getByLabel("提取间隔", { exact: true }).selectOption("15");
  await controls.getByRole("button", { name: "立即提取", exact: true }).click();
  await expect(
    page.getByText("新增 1 条候选记忆，请在待确认中审核。", { exact: true }),
  ).toBeVisible();
  expect(
    (await callsFor(page, "configure_memory_extraction")).at(-1)!.args,
  ).toEqual({ enabled: true, intervalMinutes: 15 });
  expect(await callsFor(page, "extract_memories_now")).toHaveLength(1);
});
