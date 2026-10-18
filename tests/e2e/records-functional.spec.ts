import { test, expect, installPanelBackend, callsFor } from './support/panel-backend';

test.use({ viewport: { width: 400, height: 700 }, timezoneId: 'Asia/Shanghai' });

async function openRecords(page: import('@playwright/test').Page) {
  await page.goto('/?view=panel');
  await page.getByRole('navigation', { name: '面板导航' }).getByRole('button', { name: '记录', exact: true }).click();
  await expect(page.getByLabel('记录内容', { exact: true })).toBeVisible();
}

test('record create, category, edit, reload and delete form a complete lifecycle', async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await openRecords(page);
  await page.getByLabel('记录标题', { exact: true }).fill('自动化想法');
  await page.getByLabel('记录内容', { exact: true }).fill('第一版内容');
  await page.getByLabel('记录分类', { exact: true }).selectOption('idea');
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  const card = page.getByTestId('record-card');
  await expect(card).toHaveCount(1);
  expect((await callsFor(page, 'create_memo'))[0].args.input).toEqual({ title: '自动化想法', content: '第一版内容', category: 'idea' });
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('记录内容', { exact: true })).toHaveValue('第一版内容');
  await page.getByLabel('记录标题', { exact: true }).fill('修改后的想法');
  await page.getByLabel('记录内容', { exact: true }).fill('修订后的内容');
  await page.getByRole('button', { name: /保存修改/ }).click();
  await expect(card.getByText('修改后的想法', { exact: true })).toBeVisible();
  expect((await callsFor(page, 'update_memo'))[0].args.id).toBe('ui-1');
  await page.reload();
  await page.getByRole('navigation', { name: '面板导航' }).getByRole('button', { name: '记录', exact: true }).click();
  await expect(card.getByText('修订后的内容', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await callsFor(page, 'delete_memo'))[0].args.id).toBe('ui-1');
});

test('blank record title derives from content; cancel edit never writes', async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await openRecords(page);
  await page.getByLabel('记录内容', { exact: true }).fill('正文自动作为标题\n第二行');
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByTestId('record-card').locator('strong')).toHaveText('正文自动作为标题');
  await page.getByTestId('record-card').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('记录内容', { exact: true }).fill('不应该写入');
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  expect(await callsFor(page, 'update_memo')).toHaveLength(0);
  await expect(page.getByTestId('record-card').getByText('不应该写入')).toHaveCount(0);
});

test('empty record is disabled and failed save retains the draft', async ({ healthyPage: page }) => {
  await installPanelBackend(page, { failures: { create_memo: '测试写入失败' } });
  await openRecords(page);
  await expect(page.getByRole('button', { name: '记一笔', exact: true })).toBeDisabled();
  await page.getByLabel('记录内容', { exact: true }).fill('这份草稿需要保留');
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByText('测试写入失败', { exact: true })).toBeVisible();
  await expect(page.getByLabel('记录内容', { exact: true })).toHaveValue('这份草稿需要保留');
  await expect(page.getByRole('button', { name: '记一笔', exact: true })).toBeEnabled();
  await expect(page.getByTestId('record-card')).toHaveCount(0);
});

test('history can be searched and cleared without deleting records', async ({ healthyPage: page }) => {
  await installPanelBackend(page);
  await openRecords(page);
  await page.getByLabel('记录内容', { exact: true }).fill('保留的记录');
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByTestId('record-card')).toHaveCount(1);
  const sections = page.getByRole('navigation', { name: '记录分区' });
  await sections.getByRole('button', { name: '对话历史', exact: true }).click();
  const history = page.getByRole('region', { name: '对话历史', exact: true });
  await page.getByLabel('搜索历史对话', { exact: true }).fill('自动化历史提问');
  await expect(history.getByText('自动化历史提问', { exact: true }).first()).toBeVisible();
  await history.getByRole('button', { name: '清除历史', exact: true }).click();
  await expect(history.getByText('还没有聊过天。', { exact: true })).toBeVisible();
  expect(await callsFor(page, 'clear_chat_history')).toHaveLength(1);
  await sections.getByRole('button', { name: '我的记录', exact: true }).click();
  await expect(page.getByTestId('record-card')).toHaveCount(1);
});
