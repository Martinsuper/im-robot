import { expect, it } from 'vitest';
import { notificationPermissionLabel, type NotificationStatus } from './notificationStatus';
const status: NotificationStatus = { platform: 'macos', authorization: 'authorized', alertsEnabled: true, soundsEnabled: true, alertStyle: 'banner' };
it('does not confuse native denial or an unrequested permission with authorization', () => {
  expect(notificationPermissionLabel({ ...status, authorization: 'denied' })).toBe('系统已拒绝');
  expect(notificationPermissionLabel({ ...status, authorization: 'notDetermined' })).toBe('尚未授权');
  expect(notificationPermissionLabel({ ...status, authorization: 'unknown' })).toBe('读取失败');
});
it('distinguishes authorization from disabled banners and quiet-only permission', () => {
  expect(notificationPermissionLabel(status)).toBe('已授权');
  expect(notificationPermissionLabel({ ...status, alertsEnabled: false })).toBe('已授权，提醒已关闭');
  expect(notificationPermissionLabel({ ...status, alertStyle: 'none' })).toBe('已授权，横幅已关闭');
  expect(notificationPermissionLabel({ ...status, authorization: 'provisional' })).toBe('仅静默通知');
});
