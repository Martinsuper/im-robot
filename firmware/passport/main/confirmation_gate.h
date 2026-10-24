#pragma once
#include <stdbool.h>
#include <stdint.h>
// A decision requires a fresh press after this exact card has been displayed.
typedef struct {
  uint32_t epoch, pressed_epoch;
  bool pending, visible, desktop_only;
} piko_confirmation_gate_t;
static inline void piko_confirmation_new(piko_confirmation_gate_t *g,
                                         uint32_t epoch, bool desktop) {
  *g = (piko_confirmation_gate_t){
      .epoch = epoch, .pending = true, .desktop_only = desktop};
}
static inline void piko_confirmation_show(piko_confirmation_gate_t *g,
                                          uint32_t epoch) {
  if (g->pending && g->epoch == epoch)
    g->visible = true;
}
static inline void piko_confirmation_press(piko_confirmation_gate_t *g,
                                           uint32_t epoch) {
  if (g->pending && g->visible && g->epoch == epoch)
    g->pressed_epoch = epoch;
}
static inline bool piko_confirmation_consume(piko_confirmation_gate_t *g) {
  if (!g->pending || !g->visible || g->desktop_only || !g->epoch ||
      g->pressed_epoch != g->epoch)
    return false;
  g->pending = false;
  g->pressed_epoch = 0;
  return true;
}
static inline void piko_confirmation_clear(piko_confirmation_gate_t *g) {
  g->pending = false;
  g->visible = false;
  g->pressed_epoch = 0;
}
