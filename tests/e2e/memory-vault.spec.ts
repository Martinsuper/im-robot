import { test, expect, installPanelBackend } from "./support/panel-backend";

test.use({ viewport: { width: 400, height: 760 }, timezoneId: "Asia/Shanghai" });

test("Markdown conflicts show both versions and require an explicit decision", async ({ healthyPage: page }) => {
  await installPanelBackend(page, { memory: true });
  await page.goto("/?view=panel");
  await page.evaluate(() => {
    type Args = Record<string, unknown>;
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Args) => Promise<unknown> }; __vaultDecisions: unknown[] };
    const bridge = host.__TAURI_INTERNALS__;
    const original = bridge.invoke.bind(bridge);
    host.__vaultDecisions = [];
    let enabled = true;
    let pending = true;
    const issue = { memoryId: "m1", path: "用户档案/居住城市.md", kind: "bothChanged", message: "Piko 与 Markdown 均已修改，请选择保留哪一侧", canResolve: true };
    const report = () => ({ syncedAt: 1792288800, exported: 0, imported: 0, removed: 0, issues: pending ? [issue] : [], error: null });
    bridge.invoke = async (command, args) => {
      if (command === "memory_vault_status") return { config: { enabled, directory: "/Users/piko/Notes/我的记忆库", pausedReason: null }, report: report(), trackedCount: 5, persistent: true };
      if (command === "memory_vault_preview") return { memoryId: "m1", path: issue.path, pikoTitle: "居住城市", pikoContent: "我住在上海。", fileTitle: "居住城市", fileContent: "我已经搬到杭州。", pikoVersion: "piko-version", fileVersion: "file-version", active: true, pikoMetadata: "分类：用户档案 · 重要度：3 · 标签：个人信息", fileMetadata: "分类：用户档案 · 重要度：5 · 标签：个人信息" };
      if (command === "memory_vault_resolve") { host.__vaultDecisions.push(args); pending = false; return report(); }
      if (command === "memory_vault_sync") return report();
      if (command === "memory_vault_configure") { enabled = Boolean(args?.enabled); return { config: { enabled, directory: "/Users/piko/Notes/我的记忆库", pausedReason: null }, report: report(), trackedCount: 5, persistent: true }; }
      return original(command, args);
    };
  });
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("button", { name: "Piko 记住的", exact: true }).click();
  await page.locator(".memory-vault > summary").click();
  await expect(page.getByText("/Users/piko/Notes/我的记忆库")).toBeVisible();
  await page.getByRole("button", { name: "比较并处理" }).click();
  const comparison = page.getByRole("region", { name: "比较 Markdown 与 Piko" });
  await expect(comparison.getByText("我住在上海。")).toBeVisible();
  await expect(comparison.getByText("我已经搬到杭州。")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __vaultDecisions: unknown[] }).__vaultDecisions.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/memory-vault-conflict.png", fullPage: true });
  await comparison.screenshot({ path: "artifacts/memory-vault-comparison.png" });
  page.once("dialog", dialog => dialog.accept());
  await comparison.getByRole("button", { name: "使用 Markdown 版本" }).click();
  await expect(page.getByText("已处理并重新同步。")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __vaultDecisions: unknown[] }).__vaultDecisions)).toEqual([{ input: { memoryId: "m1", path: "用户档案/居住城市.md", choice: "file", pikoVersion: "piko-version", fileVersion: "file-version" } }]);
  await page.getByRole("button", { name: "暂停同步", exact: true }).click();
  await expect(page.getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
});

test("browser preview explains that Markdown sync requires the desktop app", async ({ page }) => {
  await page.goto("/?view=panel");
  await page.getByRole("navigation", { name: "面板导航" }).getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("button", { name: "Piko 记住的", exact: true }).click();
  await page.locator(".memory-vault > summary").click();
  await expect(page.getByText("请在桌面应用中使用 Markdown 同步。")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择目录" })).toBeDisabled();
});
