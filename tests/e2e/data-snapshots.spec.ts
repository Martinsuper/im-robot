import { test, expect, installPanelBackend, callsFor } from './support/panel-backend';

test('creates a complete backup without restoring or clearing current data', async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await page.goto('/?view=panel');
  await page.getByRole('navigation', { name: '面板导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '创建完整备份', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已备份 2 个文件' })).toBeVisible();
  expect(await callsFor(page, 'create_data_snapshot')).toHaveLength(1);
  expect(await callsFor(page, 'restore_data_snapshot')).toHaveLength(0);
  expect(await callsFor(page, 'clear_my_data')).toHaveLength(0);
});

test('restore previews first, can be cancelled, and requires explicit restore-and-restart', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { snapshotDirectory: '/tmp/piko-snapshot-ui' });
  await page.goto('/?view=panel');
  await page.getByRole('navigation', { name: '面板导航' }).getByRole('button', { name: '设置', exact: true }).click();
  const choose = page.getByRole('button', { name: '恢复完整备份…', exact: true });
  await choose.click();
  await expect(page.getByRole('region', { name: '恢复确认' })).toBeVisible();
  expect(await callsFor(page, 'restore_data_snapshot')).toHaveLength(0);
  await page.getByRole('button', { name: '取消恢复', exact: true }).click();
  await expect(page.getByRole('region', { name: '恢复确认' })).toHaveCount(0);
  await choose.click();
  await page.getByRole('button', { name: '确认恢复并重启', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '正在恢复并重启 Piko' })).toBeVisible();
  expect(await callsFor(page, 'restore_data_snapshot')).toHaveLength(1);
});
