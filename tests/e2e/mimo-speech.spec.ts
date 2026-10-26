import {
  test,
  expect,
  installPanelBackend,
  callsFor,
} from "./support/panel-backend";
test.use({ viewport: { width: 400, height: 850 } });
test("MiMo voice settings save a masked key and preview in compact workspace", async ({
  healthyPage: page,
}) => {
  await installPanelBackend(page);
  await page.goto("/?view=panel");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.locator("#settings-group-ai > summary").click();
  await page.getByText("语音输出与音色", { exact: true }).click();
  const region = page.locator('[aria-label="语音输出设置"]');
  await region.getByLabel("语音服务").selectOption("mimo");
  await region.getByLabel("MiMo API Key").fill("fake-local-test-key");
  await region.getByLabel("音色", { exact: true }).selectOption("茉莉");
  await region.getByRole("button", { name: "保存并试听" }).click();
  await expect(
    region.getByText("正在播放试听。", { exact: true }),
  ).toBeVisible();
  await expect(region.getByLabel("MiMo API Key")).toHaveValue("");
  const calls = await callsFor(page, "update_speech_output_settings");
  expect(calls).toHaveLength(1);
  expect(await callsFor(page, "speak_local_text")).toHaveLength(1);
  await region.screenshot({ path: "/tmp/piko-mimo-settings.png" });
  expect(
    await region.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});
