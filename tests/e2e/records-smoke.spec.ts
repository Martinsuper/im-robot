import { expect, test } from "@playwright/test";

/**
 * R1-3 冒烟：「记录」Tab 在浏览器预览（非 Tauri）下**真的能渲染**。
 *
 * Why 单独一个文件：预览环境没有 Rust 后端，所有 runCommand 走 fallback，
 * 于是「undefined 崩掉」这类问题只有把它跑起来才会暴露——tsc 查不出来。
 * 这里只断言「渲染不崩 + 三区可达 + 搜索跨三区」，视觉回归交给整包 e2e。
 */
test.describe("records tab", () => {
  test("renders the entry form, the three sections and preview records", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`http ${response.status()}: ${response.url()}`);
    });

    await page.goto("/?view=panel");
    const nav = page.getByRole("navigation", { name: "面板导航" });
    const records = nav.getByRole("button", { name: "记录" });
    await records.click();
    await expect(records).toHaveClass(/is-active/);

    // ① 记录入口
    await expect(page.getByLabel("记录标题")).not.toBeVisible();
    await page.locator(".records-composer > summary").click();
    await expect(page.getByLabel("记录标题")).toBeVisible();
    await expect(page.getByLabel("记录内容")).toBeVisible();
    await expect(page.getByLabel("记录分类")).toBeVisible();

    // ② 三个分区（不是两个）
    const sectionNav = page.getByRole("navigation", { name: "记录分区" });
    await expect(sectionNav.getByRole("button")).toHaveCount(3);
    await expect(
      sectionNav.getByRole("button", { name: "我的记录" }),
    ).toHaveClass(/is-active/);

    // ③ 演示数据渲染出卡片，分类 chip 可用
    await expect(page.getByTestId("record-card")).not.toHaveCount(0);
    await expect(page.getByText("首页改版的三条原则")).toBeVisible();
    await expect(page.getByRole("button", { name: /^想法/ })).toBeVisible();

    expect(errors, "预览页不该有未捕获异常 / 资源错误").toEqual([]);
  });

  test("switches to Piko 记住的 and 对话历史 without crashing", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto("/?view=panel");
    await page
      .getByRole("navigation", { name: "面板导航" })
      .getByRole("button", { name: "记录" })
      .click();
    const sectionNav = page.getByRole("navigation", { name: "记录分区" });

    await sectionNav.getByRole("button", { name: "Piko 记住的" }).click();
    await expect(
      sectionNav.getByRole("button", { name: "Piko 记住的" }),
    ).toHaveClass(/is-active/);

    // 对话历史：搜索框 + 四个时间桶（全部 / 今天 / 本周 / 更早）
    await sectionNav.getByRole("button", { name: "对话历史" }).click();
    await expect(
      sectionNav.getByRole("button", { name: "对话历史" }),
    ).toHaveClass(/is-active/);
    await expect(page.getByLabel("搜索历史对话")).toBeVisible();
    // 时间桶限定在筛选区内：「今天」在顶层导航里还有一个同名按钮
    const range = page.getByRole("group", { name: "对话时间筛选" });
    await expect(range.getByRole("button", { name: "今天" })).toBeVisible();
    await expect(range.getByRole("button", { name: "本周" })).toBeVisible();
    await expect(range.getByRole("button", { name: "更早" })).toBeVisible();
    // 旧的 6 个过滤标签必须不存在
    await expect(page.getByRole("button", { name: "长回复" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "截图" })).toHaveCount(0);

    expect(errors, "切分区不该有未捕获异常").toEqual([]);
  });

  test("one search box finds content across all three sources", async ({
    page,
  }) => {
    await page.goto("/?view=panel");
    await page
      .getByRole("navigation", { name: "面板导航" })
      .getByRole("button", { name: "记录" })
      .click();

    const search = page.getByRole("textbox", { name: "搜索记录" });
    await expect(search).toBeVisible();

    // 「搬家」在演示数据里同时出现于备忘与对话历史
    await search.fill("搬家");
    const results = page.getByRole("region", { name: "搜索结果" });
    await expect(results).toBeVisible();
    await expect(results.getByText("我的记录")).toBeVisible();
    await expect(results.getByText("对话历史")).toBeVisible();
    await expect(results.getByText("搬家要带的清单")).toBeVisible();

    // 搜不到时的引导文案
    await search.fill("这个词肯定搜不到");
    await expect(
      page.getByText(/没有找到关于「这个词肯定搜不到」的内容。/),
    ).toBeVisible();
    await expect(page.getByText("要不要现在记一笔？")).toBeVisible();
  });

  test("can write a new record from the entry form", async ({ page }) => {
    await page.goto("/?view=panel");
    await page
      .getByRole("navigation", { name: "面板导航" })
      .getByRole("button", { name: "记录" })
      .click();

    await page.locator(".records-composer > summary").click();
    await page.getByLabel("记录标题").fill("冒烟测试的记录");
    await page
      .getByLabel("记录内容")
      .fill("这条是预览里写的，用来确认保存后列表会刷新。");
    await page.getByRole("button", { name: "记一笔" }).click();

    await expect(
      page.getByTestId("record-card").filter({ hasText: "冒烟测试的记录" }),
    ).toHaveCount(1);
    // 保存后输入框清空
    await expect(page.getByLabel("记录标题")).toHaveValue("");
  });
});
