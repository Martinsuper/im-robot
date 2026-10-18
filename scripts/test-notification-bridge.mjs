import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin') {
  console.log('Native notification payload tests require macOS.');
  process.exit(0);
}
const temp = mkdtempSync(path.join(tmpdir(), 'piko-notifications-'));
try {
  const source = path.join(temp, 'payload.m');
  const bridge = fileURLToPath(new URL('../src-tauri/src/soul_notifications.m', import.meta.url));
  writeFileSync(source, `#include ${JSON.stringify(bridge)}
int main(void) { @autoreleasepool {
  NSArray *values=@[
    piko_notification_status_value(UNAuthorizationStatusAuthorized, UNNotificationSettingEnabled, UNNotificationSettingEnabled, UNAlertStyleBanner),
    piko_notification_status_value(UNAuthorizationStatusDenied, UNNotificationSettingDisabled, UNNotificationSettingDisabled, UNAlertStyleNone),
    piko_notification_status_value(UNAuthorizationStatusNotDetermined, UNNotificationSettingNotSupported, UNNotificationSettingNotSupported, UNAlertStyleNone),
    piko_notification_status_value(UNAuthorizationStatusProvisional, UNNotificationSettingEnabled, UNNotificationSettingDisabled, UNAlertStyleNone)
  ];
  NSData *json=[NSJSONSerialization dataWithJSONObject:values options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
} return 0; }
`);
  const binary = path.join(temp, 'payload');
  execFileSync('clang', ['-fobjc-arc', '-fblocks', source, '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'UserNotifications', '-o', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  const values = JSON.parse(execFileSync(binary, { encoding: 'utf8' }));
  assert.deepEqual(values.map(value => value.authorization), ['authorized', 'denied', 'notDetermined', 'provisional']);
  for (const value of values) {
    assert.equal(value.ok, true);
    assert.equal(typeof value.alertsEnabled, 'boolean');
    assert.equal(typeof value.soundsEnabled, 'boolean');
  }
  assert.equal(values[0].alertsEnabled, true);
  assert.equal(values[0].alertStyle, 'banner');
  assert.equal(values[1].alertsEnabled, false);
  assert.equal(values[3].soundsEnabled, false);
  console.log('Native notification bridge: 4 authorization cases passed; JSON boolean types verified.');
} finally { rmSync(temp, { recursive: true, force: true }); }
