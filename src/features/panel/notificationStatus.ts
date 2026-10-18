export interface NotificationStatus {
  platform: string;
  authorization: string;
  alertsEnabled: boolean | null;
  soundsEnabled: boolean | null;
  alertStyle: string | null;
  lastError?: string | null;
}

export function notificationPermissionLabel(status: NotificationStatus): string {
  switch (status.authorization) {
    case 'authorized': case 'granted':
      if (status.alertsEnabled === false) return '已授权，提醒已关闭';
      if (status.alertStyle === 'none') return '已授权，横幅已关闭';
      return '已授权';
    case 'provisional': return '仅静默通知';
    case 'denied': return '系统已拒绝';
    case 'notDetermined': case 'prompt': return '尚未授权';
    default: return '读取失败';
  }
}
