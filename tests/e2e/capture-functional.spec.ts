import { test, expect, installPanelBackend, callsFor } from './support/panel-backend';

test.use({ viewport: { width: 640, height: 480 } });
for (const method of ['button', 'Enter', 'right-click'] as const) {
  test(`capture selection confirms through ${method} with normalized coordinates`, async ({ healthyPage: page }) => {
    await installPanelBackend(page, { label: 'capture' });
    await page.goto('/?view=capture');
    await expect(page.getByRole('button', { name: '确认截图', exact: true })).toBeDisabled();
    await page.mouse.move(350, 260);
    await page.mouse.down();
    await page.mouse.move(100, 100);
    await page.mouse.up();
    await expect(page.getByText('250 × 160', { exact: false })).toBeVisible();
    if (method === 'button') await page.getByRole('button', { name: '确认截图', exact: true }).click();
    else if (method === 'Enter') await page.keyboard.press('Enter');
    else await page.mouse.click(400, 300, { button: 'right' });
    await expect.poll(async () => (await callsFor(page, 'confirm_screen_capture')).length).toBe(1);
    expect((await callsFor(page, 'confirm_screen_capture'))[0].args).toEqual({ selection: { x: 100, y: 100, width: 250, height: 160 } });
  });
}

test('tiny selection cannot capture; Escape only cancels', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { label: 'capture' });
  await page.goto('/?view=capture');
  await expect(page.getByRole('button', { name: '确认截图', exact: true })).toBeDisabled();
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(103, 104); await page.mouse.up();
  await expect(page.getByRole('button', { name: '确认截图', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  expect(await callsFor(page, 'confirm_screen_capture')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await callsFor(page, 'cancel_screen_capture')).length).toBe(1);
});

test('capture denial is shown and selection remains retryable', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { label: 'capture', failures: { confirm_screen_capture: '测试屏幕录制权限被拒绝' } });
  await page.goto('/?view=capture');
  await expect(page.getByRole('button', { name: '确认截图', exact: true })).toBeDisabled();
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(300, 200); await page.mouse.up();
  await page.getByRole('button', { name: '确认截图', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('测试屏幕录制权限被拒绝');
  await expect(page.getByRole('button', { name: '确认截图', exact: true })).toBeEnabled();
});
