#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  int64_t offline_since;
  unsigned auth_failures;
  bool online;
} piko_wifi_recovery_t;

enum { PIKO_WIFI_OK = 0, PIKO_WIFI_AUTH_FAILED = 1, PIKO_WIFI_TIMEOUT = 2 };

static inline void piko_wifi_begin(piko_wifi_recovery_t *state, int64_t now) {
  *state = (piko_wifi_recovery_t){.offline_since = now};
}
static inline void piko_wifi_online(piko_wifi_recovery_t *state) {
  state->online = true;
  state->auth_failures = 0;
}
static inline void piko_wifi_disconnected(piko_wifi_recovery_t *state,
                                          int64_t now, bool auth_failed) {
  if (state->online) state->offline_since = now;
  state->online = false;
  if (auth_failed && state->auth_failures < 3) state->auth_failures++;
}
static inline unsigned piko_wifi_recover(const piko_wifi_recovery_t *state,
                                         int64_t now) {
  if (state->online) return PIKO_WIFI_OK;
  if (state->auth_failures >= 3) return PIKO_WIFI_AUTH_FAILED;
  if (now - state->offline_since >= INT64_C(30000000))
    return state->auth_failures ? PIKO_WIFI_AUTH_FAILED : PIKO_WIFI_TIMEOUT;
  return PIKO_WIFI_OK;
}
