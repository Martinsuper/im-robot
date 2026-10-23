import { test, expect, installPanelBackend, callsFor } from './support/panel-backend';

test.use({ viewport: { width: 400, height: 700 }, timezoneId: 'Asia/Shanghai' });

test('onboarding names the companion, skips model setup and stays complete after reload', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { onboarding: true });
  await page.goto('/?view=panel');
  await expect(page.getByRole('heading', { name: '欢迎使用 Piko' })).toBeVisible();
  await page.locator('#onb-companion-name').fill('测试伙伴');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接一个 AI（可跳过）' })).toBeVisible();
  await page.getByRole('button', { name: '跳过，先用本地的', exact: true }).click();
  await expect(page.getByRole('heading', { name: /认识一下\s*测试伙伴/ })).toBeVisible();
  await page.getByRole('button', { name: '开始使用', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  expect((await callsFor(page, 'complete_onboarding'))[0].args).toEqual({ companionName: '测试伙伴', onboardingVersion: '1.0' });
  expect(await callsFor(page, 'show_bubble')).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  expect(await callsFor(page, 'complete_onboarding')).toHaveLength(0);
});

test('skip onboarding is an explicit one-time command', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { onboarding: true });
  await page.goto('/?view=panel');
  await page.getByRole('button', { name: '跳过引导', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  expect(await callsFor(page, 'skip_onboarding')).toHaveLength(1);
  expect(await callsFor(page, 'update_ai_settings')).toHaveLength(0);
});

test('failed onboarding completion keeps the final step available', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { onboarding: true, failures: { complete_onboarding: '测试引导存储失败' } });
  await page.goto('/?view=panel');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '跳过，先用本地的', exact: true }).click();
  await page.getByRole('button', { name: '开始使用', exact: true }).click();
  await expect(page.getByText('测试引导存储失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始使用', exact: true })).toBeEnabled();
  expect(await callsFor(page, 'show_bubble')).toHaveLength(0);
});
