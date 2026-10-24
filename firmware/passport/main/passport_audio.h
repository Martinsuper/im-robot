#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PASSPORT_CAPTURE_BYTES 1024
#define PASSPORT_PLAY_BYTES 2048
// 512ms at 16kHz mono: tolerate a bounded network/UI scheduling pause.
#define PASSPORT_CAPTURE_BLOCKS 16
enum { PASSPORT_AUDIO_OK=0, PASSPORT_AUDIO_CAPTURE_IO=1,
       PASSPORT_AUDIO_PLAY_IO=2, PASSPORT_AUDIO_CAPTURE_BACKLOG=3 };
typedef struct {
  bool recording, record_done, play_finished;
  unsigned credits;
  int error;
} passport_audio_status_t;
esp_err_t passport_audio_init(void);
bool passport_audio_record(void);
void passport_audio_stop_record(void);
bool passport_audio_capture(uint8_t *data, size_t *len);
bool passport_audio_play(size_t expected);
bool passport_audio_play_stream(void);
bool passport_audio_end_stream(size_t bytes);
bool passport_audio_feed(const uint8_t *data, size_t len);
bool passport_audio_end(void);
void passport_audio_cancel(void);
passport_audio_status_t passport_audio_status(void);
