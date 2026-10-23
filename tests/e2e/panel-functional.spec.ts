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

for (const repeat of ["none", "daily", "weekly", "weekdays"]) {
  test(`reminder create, reload, complete and delete: ${repeat}`, async ({
    healthyPage: page,
  }) => {
    await installPanelBackend(page);
    await page.goto("/?view=panel");
    await page.locator(".today-add-disclosure > summary").click();
    await page.locator(".today-quick-add__options > summary").click();
    await page.locator(".today-focus-disclosure > summary").click();
    await page.locator(".today-calendar-tools > summary").click();
    const form = page.getByRole("region", { name: "快速添加" });
    await form.getByLabel("要做什么").fill(`自动化提醒 ${repeat}`);
    await form.getByLabel("时间", { exact: true }).fill("2026-10-18T14:00");
    await form.getByLabel("重复", { exact: true }).selectOption(repeat);
    await form.getByRole("button", { name: "添加", exact: true }).click();
    const item = page
      .getByTestId("timeline-item")
      .filter({ hasText: `自动化提醒 ${repeat}` });
    await expect(item).toHaveCount(1);
    expect((await callsFor(page, "create_reminder"))[0].args.input).toEqual({
      title: `自动化提醒 ${repeat}`,
      dueAt: 1792303200,
      repeat,
    });
    await expect(form.getByLabel("要做什么")).toHaveValue("");
    await page.reload();
    await expect(item).toHaveCount(1);
    await item
      .getByRole("button", { name: `完成 自动化提醒 ${repeat}` })
      .click();
    await expect(
      page.getByText(`已完成：自动化提醒 ${repeat}`, { exact: true }),
    ).toBeVisible();
    expect((await callsFor(page, "complete_schedule_item"))[0].args.id).toBe(
      "ui-1",
    );
    await item
      .getByRole("button", { name: `删除 自动化提醒 ${repeat}` })
      .click();
    await expect(item).toHaveCount(0);
    expect(await callsFor(page, "delete_reminder")).toHaveLength(1);
  });
}

test("calendar duration and deletion preserve an existing reminder", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page.locator(".today-add-disclosure > summary").click();
  await page.locator(".today-quick-add__options > summary").click();
  await page.locator(".today-focus-disclosure > summary").click();
  await page.locator(".today-calendar-tools > summary").click();
  const form = page.getByRole("region", { name: "快速添加" });
  await form.getByLabel("要做什么").fill("保留的提醒");
  await form.getByLabel("时间", { exact: true }).fill("2026-10-18T14:00");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(1);
  await form
    .getByRole("combobox", { name: "类型", exact: true })
    .selectOption("event");
  await form.getByLabel("要做什么").fill("自动化会议");
  await form.getByLabel("时间", { exact: true }).fill("2026-10-18T15:00");
  await form.getByLabel("时长", { exact: true }).selectOption("90");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  const event = page
    .getByTestId("timeline-item")
    .filter({ hasText: "自动化会议" });
  await expect(event).toHaveCount(1);
  const input = (await callsFor(page, "create_calendar_event"))[0].args.input;
  expect(input.endAt - input.startAt).toBe(90 * 60);
  expect(input).toMatchObject({
    title: "自动化会议",
    location: null,
    notes: null,
  });
  await expect(event.getByRole("button", { name: /完成/ })).toHaveCount(0);
  await event.getByRole("button", { name: "删除 自动化会议" }).click();
  await expect(event).toHaveCount(0);
  await expect(
    page.getByTestId("timeline-item").filter({ hasText: "保留的提醒" }),
  ).toHaveCount(1);
});

for (const minutes of [15, 25, 45, 60]) {
  test(`focus ${minutes} minutes: start, pause, resume, stop`, async ({
    healthyPage: page,
  }) => {
    await installPanelBackend(page);
    await page.goto("/?view=panel");
    await page.locator(".today-add-disclosure > summary").click();
    await page.locator(".today-quick-add__options > summary").click();
    await page.locator(".today-focus-disclosure > summary").click();
    await page.locator(".today-calendar-tools > summary").click();
    const focus = page.getByRole("region", { name: "专注与休息" });
    await focus
      .locator(".today-focus__durations")
      .getByRole("button", { name: `${minutes} 分钟`, exact: true })
      .click();
    await expect(focus.getByRole("heading", { name: "专注中" })).toBeVisible();
    expect((await callsFor(page, "start_focus"))[0].args).toEqual({ minutes });
    await focus.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(
      focus.getByRole("button", { name: "继续", exact: true }),
    ).toBeVisible();
    await focus.getByRole("button", { name: "继续", exact: true }).click();
    await expect(
      focus.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    await focus.getByRole("button", { name: "结束", exact: true }).click();
    await expect(page.locator(".today-focus-disclosure")).not.toHaveAttribute(
      "open",
      /.*/,
    );
    for (const command of ["pause_focus", "resume_focus", "stop_focus"])
      expect(await callsFor(page, command)).toHaveLength(1);
  });
}

for (const minutes of [5, 10, 15]) {
  test(`break ${minutes} minutes starts and stops`, async ({
    healthyPage: page,
  }) => {
    await installPanelBackend(page);
    await page.goto("/?view=panel");
    await page.locator(".today-add-disclosure > summary").click();
    await page.locator(".today-quick-add__options > summary").click();
    await page.locator(".today-focus-disclosure > summary").click();
    await page.locator(".today-calendar-tools > summary").click();
    const focus = page.getByRole("region", { name: "专注与休息" });
    await focus
      .locator(".today-focus__breaks")
      .getByRole("button", { name: `${minutes} 分钟`, exact: true })
      .click();
    await expect(focus.getByRole("heading", { name: "休息中" })).toBeVisible();
    expect((await callsFor(page, "start_break"))[0].args).toEqual({ minutes });
    await focus.getByRole("button", { name: "结束", exact: true }).click();
    await expect(page.locator(".today-focus-disclosure")).not.toHaveAttribute(
      "open",
      /.*/,
    );
  });
}

test("failed quick-add preserves input and allows retry", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, {
    failures: { create_reminder: "测试存储不可用" },
  });
  await page.goto("/?view=panel");
  await page.locator(".today-add-disclosure > summary").click();
  await page.locator(".today-quick-add__options > summary").click();
  await page.locator(".today-focus-disclosure > summary").click();
  await page.locator(".today-calendar-tools > summary").click();
  const form = page.getByRole("region", { name: "快速添加" });
  await form.getByLabel("要做什么").fill("失败后保留草稿");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("测试存储不可用", { exact: true })).toBeVisible();
  await expect(form.getByLabel("要做什么")).toHaveValue("失败后保留草稿");
  await expect(
    form.getByRole("button", { name: "添加", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("timeline-item")).toHaveCount(0);
});

test("sync pushes then pulls; export opens only after explicit action", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page.locator(".today-add-disclosure > summary").click();
  await page.locator(".today-quick-add__options > summary").click();
  await page.locator(".today-focus-disclosure > summary").click();
  await page.locator(".today-calendar-tools > summary").click();
  await page
    .getByRole("button", { name: "与系统日历同步", exact: true })
    .click();
  await expect(
    page.getByText("已与系统日历同步：推出 2 条、导入 1 条", { exact: true }),
  ).toBeVisible();
  const sync = await page.evaluate(() =>
    (window as any).__uiTest.calls
      .filter((call: any) => call.command.startsWith("sync_calendar_"))
      .map((call: any) => call.command),
  );
  expect(sync).toEqual([
    "sync_calendar_to_system",
    "sync_calendar_from_system",
  ]);
  await page
    .getByRole("button", { name: "导出 iCalendar", exact: true })
    .click();
  await expect(page.getByText("日程已导出", { exact: true })).toBeVisible();
  expect((await callsFor(page, "export_calendar_events"))[0].args).toEqual({
    path: "/isolated-ui-test/calendar.ics",
  });
  expect(await callsFor(page, "open_calendar_import")).toHaveLength(0);
  await page
    .getByRole("button", { name: "交给系统日历导入", exact: true })
    .click();
  expect(await callsFor(page, "open_calendar_import")).toHaveLength(1);
});

test("cancel export does not write or open a file", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page, { savePath: null });
  await page.goto("/?view=panel");
  await page.locator(".today-add-disclosure > summary").click();
  await page.locator(".today-quick-add__options > summary").click();
  await page.locator(".today-focus-disclosure > summary").click();
  await page.locator(".today-calendar-tools > summary").click();
  await page
    .getByRole("button", { name: "导出 iCalendar", exact: true })
    .click();
  await expect
    .poll(async () => (await callsFor(page, "plugin:dialog|save")).length)
    .toBe(1);
  expect(await callsFor(page, "export_calendar_events")).toHaveLength(0);
  expect(await callsFor(page, "open_calendar_import")).toHaveLength(0);
});

test("workspace returns to the existing native conversation without opening another window", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(page.getByLabel("发送给 Piko 的问题")).toBeVisible();
  expect(await callsFor(page, "show_bubble")).toHaveLength(0);
});
