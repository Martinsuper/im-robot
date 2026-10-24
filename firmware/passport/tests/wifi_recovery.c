#include <assert.h>
#include <stdio.h>
#include "wifi_recovery.h"
int main(void) {
  piko_wifi_recovery_t s;
  piko_wifi_begin(&s, 0);
  assert(!piko_wifi_recover(&s, 29999999));
  assert(piko_wifi_recover(&s, 30000000) == PIKO_WIFI_TIMEOUT);
  piko_wifi_begin(&s, 100);
  for (int i = 0; i < 2; i++) {
    piko_wifi_disconnected(&s, 1000+i, true);
    assert(!piko_wifi_recover(&s, 1000+i));
  }
  piko_wifi_disconnected(&s, 1003, true);
  assert(piko_wifi_recover(&s, 1003) == PIKO_WIFI_AUTH_FAILED);
  piko_wifi_begin(&s, 0);
  piko_wifi_disconnected(&s, 100, true);
  assert(piko_wifi_recover(&s, 30000000) == PIKO_WIFI_AUTH_FAILED);
  piko_wifi_online(&s);
  assert(!piko_wifi_recover(&s, 999999999)); // Missing desktop is not a Wi-Fi failure.
  assert(!s.auth_failures);
  piko_wifi_disconnected(&s, 1000000000, false);
  piko_wifi_disconnected(&s, 1020000000, false); // Retrying does not extend deadline.
  assert(!piko_wifi_recover(&s, 1029999999));
  assert(piko_wifi_recover(&s, 1030000000) == PIKO_WIFI_TIMEOUT);
  piko_wifi_online(&s);
  assert(!piko_wifi_recover(&s, 2000000000));
  puts("PASS Wi-Fi: auth failure limit, 30s timeout, reconnect deadline, successful recovery, desktop discovery unaffected");
}
