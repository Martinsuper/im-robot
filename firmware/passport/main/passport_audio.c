#include "passport_audio.h"
#include "bsp_audio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <string.h>

typedef struct {
  size_t len;
  unsigned generation;
  uint8_t data[PASSPORT_CAPTURE_BYTES];
} capture_t;
typedef struct {
  size_t len;
  unsigned generation;
  uint8_t data[PASSPORT_PLAY_BYTES];
} playback_t;
static QueueHandle_t capture_queue, playback_queue;
static SemaphoreHandle_t lock;
static bool ready, recording, record_done, playing, ended, finished;
static unsigned generation, credits;
static size_t expected, received, played;
static bool streaming;
static int error;
// Single worker owns all blocking I2S reads and writes; no I/O in button
// callbacks.
static void audio_worker(void *unused) {
  (void)unused;
  static capture_t capture;
  static playback_t playback;
  while (true) {
    xSemaphoreTake(lock, portMAX_DELAY);
    bool rec = recording, play = playing;
    unsigned gen = generation;
    xSemaphoreGive(lock);
    if (rec) {
      esp_err_t result = bsp_audio_read(capture.data, sizeof(capture.data));
      xSemaphoreTake(lock, portMAX_DELAY);
      if (generation == gen) {
        capture.len = sizeof(capture.data);
        capture.generation = gen;
        if (result != ESP_OK ||
            xQueueSend(capture_queue, &capture, 0) != pdTRUE) {
          error = result != ESP_OK ? PASSPORT_AUDIO_CAPTURE_IO : PASSPORT_AUDIO_CAPTURE_BACKLOG;
          recording = false;
        }
        if (!recording)
          record_done = true;
      }
      xSemaphoreGive(lock);
    } else if (play) {
      if (xQueueReceive(playback_queue, &playback, pdMS_TO_TICKS(10)) ==
          pdTRUE) {
        xSemaphoreTake(lock, portMAX_DELAY);
        bool current = playing && playback.generation == generation;
        gen = playback.generation;
        xSemaphoreGive(lock);
        if (!current)
          continue;
        esp_err_t result = bsp_audio_write(playback.data, playback.len);
        xSemaphoreTake(lock, portMAX_DELAY);
        if (generation == gen) {
          if (result != ESP_OK) {
            error = PASSPORT_AUDIO_PLAY_IO;
            playing = false;
          } else {
            credits++;
            played += playback.len;
          }
        }
        xSemaphoreGive(lock);
      }
      xSemaphoreTake(lock, portMAX_DELAY);
      if (playing && ended && played == expected) {
        playing = false;
        finished = true;
      }
      xSemaphoreGive(lock);
    } else {
      xSemaphoreTake(lock, portMAX_DELAY);
      if (!recording)
        record_done = true;
      xSemaphoreGive(lock);
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}
esp_err_t passport_audio_init(void) {
  esp_err_t result = bsp_audio_init();
  if (result != ESP_OK)
    return result;
  result = bsp_audio_set_format(16000, 16, 1);
  if (result != ESP_OK)
    return result;
  lock = xSemaphoreCreateMutex();
  capture_queue = xQueueCreate(PASSPORT_CAPTURE_BLOCKS, sizeof(capture_t));
  playback_queue = xQueueCreate(4, sizeof(playback_t));
  if (!lock || !capture_queue || !playback_queue) {
    if (lock)
      vSemaphoreDelete(lock);
    if (capture_queue)
      vQueueDelete(capture_queue);
    if (playback_queue)
      vQueueDelete(playback_queue);
    lock = NULL;
    return ESP_ERR_NO_MEM;
  }
  record_done = true;
  bsp_audio_set_volume(55);
  if (xTaskCreate(audio_worker, "piko_audio", 4096, NULL, 5, NULL) != pdPASS) {
    vSemaphoreDelete(lock);
    vQueueDelete(capture_queue);
    vQueueDelete(playback_queue);
    lock = NULL;
    return ESP_ERR_NO_MEM;
  }
  ready = true;
  return ESP_OK;
}
void passport_audio_cancel(void) {
  if (!ready)
    return;
  xSemaphoreTake(lock, portMAX_DELAY);
  generation++;
  recording = false;
  playing = false;
  ended = false;
  finished = false;
  record_done = false;
  credits = 0;
  error = 0;
  xQueueReset(capture_queue);
  xQueueReset(playback_queue);
  xSemaphoreGive(lock);
}
bool passport_audio_record(void) {
  if (!ready)
    return false;
  passport_audio_cancel();
  xSemaphoreTake(lock, portMAX_DELAY);
  recording = true;
  record_done = false;
  xSemaphoreGive(lock);
  return true;
}
void passport_audio_stop_record(void) {
  if (!ready)
    return;
  xSemaphoreTake(lock, portMAX_DELAY);
  recording = false;
  xSemaphoreGive(lock);
}
bool passport_audio_capture(uint8_t *data, size_t *len) {
  if (!ready)
    return false;
  capture_t chunk;
  while (xQueueReceive(capture_queue, &chunk, 0) == pdTRUE) {
    xSemaphoreTake(lock, portMAX_DELAY);
    bool valid = chunk.generation == generation;
    xSemaphoreGive(lock);
    if (valid) {
      memcpy(data, chunk.data, chunk.len);
      *len = chunk.len;
      return true;
    }
  }
  return false;
}
bool passport_audio_play(size_t bytes) {
  if (!ready || !bytes || bytes > 16000 * 2 * 40 || bytes % 2)
    return false;
  passport_audio_cancel();
  xSemaphoreTake(lock, portMAX_DELAY);
  streaming = false;
  expected = bytes;
  received = 0;
  played = 0;
  playing = true;
  xSemaphoreGive(lock);
  return true;
}
bool passport_audio_play_stream(void) {
  if (!passport_audio_play(16000 * 2 * 40)) return false;
  xSemaphoreTake(lock, portMAX_DELAY); streaming = true; xSemaphoreGive(lock);
  return true;
}
bool passport_audio_end_stream(size_t bytes) {
  if (!ready || !bytes || bytes > 16000 * 2 * 40 || bytes % 2) return false;
  xSemaphoreTake(lock, portMAX_DELAY);
  bool ok = playing && streaming && received == bytes;
  if (ok) { expected = bytes; ended = true; }
  xSemaphoreGive(lock);
  return ok;
}

bool passport_audio_feed(const uint8_t *data, size_t len) {
  if (!ready || !len || len > PASSPORT_PLAY_BYTES || len % 2)
    return false;
  playback_t chunk;
  chunk.len = len;
  memcpy(chunk.data, data, len);
  xSemaphoreTake(lock, portMAX_DELAY);
  chunk.generation = generation;
  bool ok = playing && received + len <= expected &&
            xQueueSend(playback_queue, &chunk, 0) == pdTRUE;
  if (ok)
    received += len;
  xSemaphoreGive(lock);
  return ok;
}
bool passport_audio_end(void) {
  if (!ready)
    return false;
  xSemaphoreTake(lock, portMAX_DELAY);
  bool ok = playing && received == expected;
  if (ok)
    ended = true;
  xSemaphoreGive(lock);
  return ok;
}
passport_audio_status_t passport_audio_status(void) {
  passport_audio_status_t status = {0};
  if (!ready)
    return status;
  xSemaphoreTake(lock, portMAX_DELAY);
  status = (passport_audio_status_t){.recording = recording,
                                     .record_done = record_done,
                                     .play_finished = finished,
                                     .credits = credits,
                                     .error = error};
  credits = 0;
  error = 0;
  finished = false;
  xSemaphoreGive(lock);
  return status;
}
