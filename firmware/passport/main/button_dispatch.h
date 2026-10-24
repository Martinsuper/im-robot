#pragma once
#include "bsp_button.h"
#include <stdbool.h>

/* The input app uses UP hold-to-talk and DOWN fresh-press Enter, whereas
 * existing Piko pages only consume raw press/release on OK. */
static inline bool passport_button_should_queue(bsp_btn_t key, bsp_btn_ev_t event,
                                                bool input_mode) {
    return event == BSP_BTN_CLICK || event == BSP_BTN_LONG ||
        ((key == BSP_BTN_OK || input_mode) &&
         (event == BSP_BTN_PRESS || event == BSP_BTN_RELEASE));
}
