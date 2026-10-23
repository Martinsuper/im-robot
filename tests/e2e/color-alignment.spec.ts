import { test, expect, installPanelBackend } from './support/panel-backend';

for (const theme of ['sage', 'blue', 'peach']) {
  test(`${theme} theme stays consistent across navigation, chat, calendar and settings`, async ({ healthyPage: page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPanelBackend(page);
    await page.addInitScript(theme => {
      (window as any).__uiTest.state.settings.theme = theme;
    }, theme);
    await page.goto('/?view=panel');
    const shell = page.locator('.conversation-tabs');
    const accent = await shell.evaluate(el => getComputedStyle(el).getPropertyValue('--piko-accent').trim());
    expect(accent).toBe({ sage: '#28745c', blue: '#346c9b', peach: '#a65f3c' }[theme]);
    for (const selector of ['.bubble-shell', '.panel-shell']) {
      expect(await page.locator(selector).evaluate(el => getComputedStyle(el).getPropertyValue('--piko-accent').trim())).toBe(accent);
    }
    const activeNav = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '今天', exact: true });
    const activeColor = await activeNav.evaluate(el => getComputedStyle(el).color);
    expect(await page.locator('.schedule-calendar__legend i').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(activeColor);
    expect(await page.locator('.studio-navigation__new').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await testInfo.attach('today', { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('#settings-group-companion > summary').click();
    const fields = page.locator('#settings-group-companion .settings-form').locator('input:not([type=checkbox]), select');
    const rects = await fields.evaluateAll(els => els.map(el => ({ left: el.getBoundingClientRect().left, height: el.getBoundingClientRect().height })));
    expect(rects.length).toBeGreaterThan(1);
    for (const rect of rects) {
      expect(Math.abs(rect.left - rects[0].left)).toBeLessThanOrEqual(1);
      expect(rect.height).toBeGreaterThanOrEqual(36);
    }
    await testInfo.attach('settings', { body: await page.screenshot(), contentType: 'image/png' });
    for (const width of [360, 400, 760]) {
      await page.setViewportSize({ width, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}
