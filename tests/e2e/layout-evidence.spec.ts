import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 360, height: 560 }, { width: 400, height: 700 }]) {
  test(`all panel tabs fit the supported ${viewport.width}x${viewport.height} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/?view=panel');
    const nav = page.getByRole('navigation', { name: '主导航' });
    for (const tab of ['今天', '记录', '设置']) {
      await nav.getByRole('button', { name: tab, exact: true }).click();
      await expect(nav.getByRole('button', { name: tab, exact: true })).toHaveClass(/is-active/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tab} must not overflow horizontally`).toBe(true);
      const shot = await page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 5000 });
      await testInfo.attach(`${tab}-${viewport.width}x${viewport.height}`, { body: shot, contentType: 'image/png' });
    }
  });
}
