#include "confirmation_gate.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  piko_confirmation_gate_t gate = {0};
  piko_confirmation_new(&gate, 1, false);
  // Delayed release/click from recording cannot approve a newly arrived card.
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_press(&gate, 1);
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_show(&gate, 1);
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_press(&gate, 1);
  assert(piko_confirmation_consume(&gate));
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_new(&gate, 2, false);
  piko_confirmation_show(&gate, 1);
  assert(!gate.visible);
  piko_confirmation_show(&gate, 2);
  piko_confirmation_press(&gate, 1);
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_press(&gate, 2);
  piko_confirmation_new(&gate, 3, false);
  piko_confirmation_show(&gate, 3);
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_press(&gate, 3);
  assert(piko_confirmation_consume(&gate));
  piko_confirmation_new(&gate, 4, true);
  piko_confirmation_show(&gate, 4);
  piko_confirmation_press(&gate, 4);
  assert(!piko_confirmation_consume(&gate));
  piko_confirmation_clear(&gate);
  assert(!piko_confirmation_consume(&gate));
  puts("PASS: explicit fresh press, display-before-confirm, stale/repeated "
       "decision rejection, desktop-only gate");
}
