import { expect, test } from "@playwright/test";
import { installPanelBackend, callsFor } from "./support/panel-backend";

// Real Chromium pointer events and DOM layout; native window APIs remain doubles.
// This does not assert that macOS delivers a click to an underlying application.
test.use({ viewport: { width: 260, height: 300 } });
test("pet input: blank space, tap, captured drag, right menu and visible reminder", async ({ page }) => {
  await installPanelBackend(page);
  await page.addInitScript(() => {
    const bridge = window as any;
    const original = bridge.__TAURI_INTERNALS__.invoke;
    let cursor = { x: 0, y: 0 };
    document.addEventListener("pointermove", (event) => { cursor = { x: event.clientX, y: event.clientY }; });
    bridge.__TAURI_INTERNALS__.metadata.currentWindow.label = "pet";
    bridge.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command.startsWith("plugin:window|") || ["get_pet_position", "move_pet", "show_pet_context_menu", "soul_get_mood"].includes(command)) {
        bridge.__uiTest.calls.push({ command, args: structuredClone(args) });
        if (command.endsWith("cursor_position")) return cursor;
        if (command.endsWith("inner_position")) return { x: 0, y: 0 };
        if (command.endsWith("scale_factor")) return 1;
        if (command === "get_pet_position") return [0, 0];
        if (command === "move_pet") return [args.x, args.y];
        if (command === "soul_get_mood") return "calm";
        return null;
      }
      return original(command, args);
    };
  });
  await page.goto("/?view=pet");
  const pet = page.getByRole("button", { name: "打开 Piko 对话（可拖动）" });
  await expect(pet).toBeVisible();
  const lastIgnore = () => page.evaluate(() => (window as any).__uiTest.calls.filter((c: any) => c.command === "plugin:window|set_ignore_cursor_events").at(-1)?.args.value);
  await expect.poll(lastIgnore).toBe(true);
  await page.mouse.click(5, 290);
  expect(await callsFor(page, "show_bubble")).toHaveLength(0);

  await pet.hover();
  await expect.poll(lastIgnore).toBe(false);
  await pet.click();
  expect((await callsFor(page, "show_bubble")).length).toBeGreaterThan(0);
  const chatCalls = (await callsFor(page, "show_bubble")).length;
  await pet.hover();
  await page.mouse.down();
  await page.mouse.move(5, 290, { steps: 4 });
  await expect.poll(async () => (await callsFor(page, "move_pet")).length).toBeGreaterThan(0);
  await expect.poll(lastIgnore).toBe(false);
  await page.mouse.up();
  await expect.poll(lastIgnore).toBe(true);
  expect(await callsFor(page, "show_bubble")).toHaveLength(chatCalls);

  await pet.click({ button: "right" });
  expect(await callsFor(page, "show_pet_context_menu")).toHaveLength(1);
  await page.mouse.move(5, 290);
  await expect.poll(lastIgnore).toBe(true);

  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "pet-visual-event", payload: { type: "reminder-fired", message: "自动化提醒" },
    });
  });
  const notice = page.getByRole("button", { name: "关闭提醒" });
  await expect(notice).toBeVisible();
  await notice.hover();
  await expect.poll(lastIgnore).toBe(false);
  await notice.click();
  await expect(notice).toHaveCount(0);
  await expect.poll(lastIgnore).toBe(true);
  expect(await callsFor(page, "show_bubble")).toHaveLength(chatCalls);
});
