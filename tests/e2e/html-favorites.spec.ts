import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1200, height: 1000 }, userAgent: "Mozilla/5.0 Windows NT 10.0" });

async function installBackend(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { topic: string; handler: number }>();
    let sequence = 0;
    const state = {
      frames: {} as Record<string, string>,
      calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
      emit(payload: Record<string, unknown>) {
        for (const [id, listener] of listeners) {
          if (listener.topic === "agent-event") callbacks.get(listener.handler)?.({ event: "agent-event", id, payload });
        }
      },
    };
    const win = window as unknown as Record<string, unknown>;
    win.__favoriteTest = state;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
    win.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "bubble" }, currentWebview: { label: "bubble" } },
      transformCallback(callback: (event: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: Record<string, unknown> = {}) {
        state.calls.push({ command, args });
        if (["get_pet_state", "migrate_pet_state", "save_pet_state"].includes(command)) {
          const owner = window as unknown as { __petWire?: { schemaVersion: number; initialized: boolean; entries: Record<string, { revision: number; value: string | null }> } };
          const pet = owner.__petWire ??= { schemaVersion: 1, initialized: true, entries: {} };
          const payload = (args ?? {}) as Record<string, unknown>;
          if (command === "save_pet_state") {
            const key = String(payload.key); const previous = pet.entries[key] ?? { revision: 0, value: null };
            if (previous.revision !== payload.expectedRevision) throw new Error("pet state conflict");
            return pet.entries[key] = { revision: previous.revision + 1, value: payload.value as string | null };
          }
          return structuredClone(pet);
        }
        if (command === "background_status") return [];
        if (command === "get_data_health") return { memoryPersistent: true, sqlite: { acquisitions: 0, waitMicros: 0, holdMicros: 0 }, jsonLockAcquisitions: 0, jsonLockWaitMicros: 0, speechRecognition: true, wasmPlugins: true };

        if (command === "plugin:event|listen") {
          const id = ++sequence;
          listeners.set(id, { topic: String(args.event), handler: Number(args.handler) });
          return id;
        }
        if (command === "get_settings") return {
          companionName: "Piko", theme: "sage", language: "zh-CN", hasApiKey: true, htmlPreviewEnabled: true,
          ai: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "ui-test" },
        };
        if (command === "get_bubble_chat_history") return [{ id: "history-1", prompt: "历史页面", response: "```html\n<h1>Historical HTML</h1>\n```", createdAt: 1 }];
        if (command === "list_html_favorites") return [{ id: "saved-1", title: "Saved calculator", html: "<h1>Saved calculator</h1><button onclick=\"this.textContent='Favorite script OK'\">Run saved script</button>", createdAt: 1, updatedAt: 1 }];
        if (command === "create_html_preview_frame") {
          const token = `frame-${++sequence}`;
          state.frames[token] = String(args.html);
          return token;
        }
        if (command === "remove_html_preview_frame") { delete state.frames[String(args.token)]; return; }
        return null;
      },
    };
  });
  await page.route("http://preview.localhost/frame/**", async (route) => {
    const token = route.request().url().split("/").at(-1)!;
    const html = await page.evaluate((token) => (window as unknown as { __favoriteTest: { frames: Record<string, string> } }).__favoriteTest.frames[token], token);
    await route.fulfill({ contentType: "text/html", body: html || "" });
  });
  await page.goto("/?view=bubble");
}

async function selectFavorite(page: Page) {
  const context = page.getByTestId("chat-context-toggle");
  if (await context.getAttribute("aria-expanded") !== "true") await context.click();
  await page.getByRole("button", { name: /收藏卡片/ }).click();
  await page.getByRole("button", { name: "Saved calculator", exact: true }).click();
  const favorite = page.getByRole("dialog", { name: "收藏卡片预览" });
  await expect(favorite.frameLocator("iframe").getByRole("heading", { name: "Saved calculator" })).toBeInViewport();
  return favorite;
}

async function reply(page: Page, text: string) {
  await page.getByLabel("发送给 Piko 的问题").fill("测试当前回复");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __favoriteTest: { calls: Array<{ command: string }> } }).__favoriteTest.calls.filter((call) => call.command === "agent_start").length)).toBeGreaterThan(0);
  await page.evaluate((text) => {
    const state = (window as unknown as { __favoriteTest: { calls: Array<{ command: string; args: { input?: { requestId: string } } }>; emit: (event: Record<string, unknown>) => void } }).__favoriteTest;
    const requestId = state.calls.filter((call) => call.command === "agent_start").at(-1)!.args.input!.requestId;
    state.emit({ type: "delta", requestId, text });
    state.emit({ type: "completed", requestId });
  }, text);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
}

test("favorites open on startup and in a new conversation without a current reply", async ({ page }) => {
  await installBackend(page);
  const favorite = await selectFavorite(page);
  await favorite.frameLocator("iframe").getByRole("button", { name: "Run saved script" }).click();
  await expect(favorite.frameLocator("iframe").getByRole("button", { name: "Favorite script OK" })).toBeVisible();
  await favorite.getByRole("button", { name: "关闭收藏预览" }).click();
  await expect(favorite).toHaveCount(0);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await selectFavorite(page);
});

for (const html of [false, true]) test(`favorites coexist with the current ${html ? "HTML" : "text"} reply`, async ({ page }) => {
  await installBackend(page);
  await reply(page, html ? "```html\n<h1>Current HTML reply</h1>\n```" : "Current text reply");
  const current = page.locator(".bubble-thread__current");
  if (html) await expect(current.frameLocator("iframe").getByRole("heading", { name: "Current HTML reply" })).toBeVisible();
  else await expect(current.getByText("Current text reply", { exact: true })).toBeVisible();
  const favorite = await selectFavorite(page);
  if (html) await expect(current.frameLocator("iframe").getByRole("heading", { name: "Current HTML reply" })).toBeVisible();
  else await expect(current.getByText("Current text reply", { exact: true })).toBeVisible();
  await favorite.getByRole("button", { name: "关闭收藏预览" }).click();
  await expect(favorite).toHaveCount(0);
  if (html) await expect(current.locator("iframe")).toHaveCount(1);
  else await expect(current.getByText("Current text reply", { exact: true })).toBeVisible();
});

test("history tabs select their named mode and repeated clicks preserve it", async ({ page }) => {
  await installBackend(page);
  const history = page.locator(".bubble-thread__history-item");
  await history.locator(".bubble-thread__history-toggle").click();
  const preview = history.getByRole("tab", { name: "预览", exact: true });
  const source = history.getByRole("tab", { name: "源码", exact: true });
  await expect(preview).toHaveAttribute("aria-selected", "true");
  await preview.click();
  await expect(preview).toHaveAttribute("aria-selected", "true");
  await source.click();
  await expect(source).toHaveAttribute("aria-selected", "true");
  await expect(history.locator("pre code")).toContainText("<h1>Historical HTML</h1>");
  await source.click();
  await expect(source).toHaveAttribute("aria-selected", "true");
  await preview.click();
  await expect(preview).toHaveAttribute("aria-selected", "true");
  await expect(history.frameLocator("iframe").getByRole("heading", { name: "Historical HTML" })).toBeVisible();
});

test("favorite dialog supports source mode, Escape, backdrop dismissal and focus return", async ({ page }) => {
  await installBackend(page);
  const favorite = await selectFavorite(page);
  await expect(favorite).toHaveJSProperty("open", true);
  await favorite.getByRole("tab", { name: "源码", exact: true }).click();
  await expect(favorite.locator("pre code")).toContainText("<h1>Saved calculator</h1>");
  await page.keyboard.press("Escape");
  await expect(favorite).toHaveCount(0);
  await expect(page.getByRole("button", { name: /收藏卡片/ })).toBeFocused();
  await selectFavorite(page);
  await page.mouse.click(4, 4);
  await expect(favorite).toHaveCount(0);
  await expect(page.getByRole("button", { name: /收藏卡片/ })).toBeFocused();
  const hidden = await page.evaluate(() => (window as unknown as { __favoriteTest: { calls: Array<{ command: string }> } }).__favoriteTest.calls.some((call) => call.command === "hide_bubble"));
  expect(hidden).toBe(false);
});

test("favorite dialog fits a small window and Escape works from the preview iframe", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 420 });
  await installBackend(page);
  const favorite = await selectFavorite(page);
  const box = (await favorite.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  await expect(favorite.getByRole("button", { name: "独立窗口打开" })).toBeInViewport();
  await favorite.frameLocator("iframe").getByRole("button", { name: "Run saved script" }).click();
  await page.keyboard.press("Escape");
  await expect(favorite).toHaveCount(0);
  await expect(page.getByRole("button", { name: /收藏卡片/ })).toBeFocused();
});
