#pragma once
#include <stdbool.h>

typedef struct {
    bool opened, candidate, selected, recording, draining, error;
    char peer[16];
    unsigned blocks;
} voice_input_status_t;

/* Called only by the application loop. Audio I/O remains in passport_audio's worker. */
bool voice_input_open(void);
void voice_input_close(void);
void voice_input_tick(bool wifi_ready);
bool voice_input_select(void);
void voice_input_press(void);
void voice_input_release(void);
void voice_input_enter_key(void);
voice_input_status_t voice_input_status(void);
