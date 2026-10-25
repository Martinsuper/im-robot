#include "passport_audio.h"
#include "bsp_audio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <string.h>
#include <stdatomic.h>

// Implemented by the build-local BSP lifecycle extension.
esp_err_t passport_bsp_audio_deinit(void);

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
static _Atomic(SemaphoreHandle_t) lock;
static bool worker_running,stop_requested,teardown_pending;
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
    if(stop_requested){
      worker_running=false;
      xSemaphoreGive(lock);
      vTaskDelete(NULL);
      return;
    }
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
// Control-task-only init/deinit; all data APIs serialize with this persistent
// mutex, so delayed network callbacks cannot race queue deletion.
static bool audio_lock_ready(void) {
  if(!lock)return false;
  xSemaphoreTake(lock,portMAX_DELAY);
  if(!ready){xSemaphoreGive(lock);return false;}
  return true;
}
static esp_err_t release_bsp(void) {
  esp_err_t result=passport_bsp_audio_deinit();
  xSemaphoreTake(lock,portMAX_DELAY);teardown_pending=result!=ESP_OK;xSemaphoreGive(lock);
  return result;
}
esp_err_t passport_audio_init(void) {
  if(!lock)lock=xSemaphoreCreateMutex();
  if(!lock)return ESP_ERR_NO_MEM;
  xSemaphoreTake(lock,portMAX_DELAY);
  bool existing=ready,stopping=worker_running,pending=teardown_pending;
  xSemaphoreGive(lock);
  if(existing)return ESP_OK;
  if(stopping)return ESP_ERR_INVALID_STATE;
  if(pending){esp_err_t cleanup=passport_audio_deinit();if(cleanup!=ESP_OK)return cleanup;}
  esp_err_t result=bsp_audio_init();
  if(result==ESP_OK)result=bsp_audio_set_format(16000,16,1);
  if(result!=ESP_OK){release_bsp();return result;}
  capture_queue=xQueueCreate(PASSPORT_CAPTURE_BLOCKS,sizeof(capture_t));
  playback_queue=xQueueCreate(4,sizeof(playback_t));
  if(!capture_queue||!playback_queue){
    if(capture_queue)vQueueDelete(capture_queue);
    if(playback_queue)vQueueDelete(playback_queue);
    capture_queue=playback_queue=NULL;
    release_bsp();return ESP_ERR_NO_MEM;
  }
  xSemaphoreTake(lock,portMAX_DELAY);
  generation++;recording=record_done=playing=ended=finished=streaming=false;
  expected=received=played=credits=0;error=0;
  stop_requested=false;worker_running=true;
  xSemaphoreGive(lock);
  bsp_audio_set_volume(55);
  if(xTaskCreate(audio_worker,"piko_audio",4096,NULL,5,NULL)!=pdPASS){
    xSemaphoreTake(lock,portMAX_DELAY);worker_running=false;xSemaphoreGive(lock);
    vQueueDelete(capture_queue);vQueueDelete(playback_queue);
    capture_queue=playback_queue=NULL;
    release_bsp();return ESP_ERR_NO_MEM;
  }
  xSemaphoreTake(lock,portMAX_DELAY);ready=true;xSemaphoreGive(lock);
  return ESP_OK;
}
esp_err_t passport_audio_deinit(void) {
  if(!lock)return ESP_OK;
  xSemaphoreTake(lock,portMAX_DELAY);
  ready=false;generation++;recording=playing=false;stop_requested=true;teardown_pending=true;
  xSemaphoreGive(lock);
  // Do not delete a task blocked inside I2S. Let it finish its bounded I/O.
  for(unsigned wait=0;;wait++){
    xSemaphoreTake(lock,portMAX_DELAY);bool running=worker_running;xSemaphoreGive(lock);
    if(!running)break;
    if(wait>=200)return ESP_ERR_TIMEOUT;
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  xSemaphoreTake(lock,portMAX_DELAY);
  if(capture_queue)vQueueDelete(capture_queue);
  if(playback_queue)vQueueDelete(playback_queue);
  capture_queue=playback_queue=NULL;
  record_done=ended=finished=streaming=false;
  expected=received=played=credits=0;error=0;
  xSemaphoreGive(lock);
  return release_bsp();
}
void passport_audio_cancel(void) {
  if(!audio_lock_ready())return;
  generation++;recording=playing=ended=finished=record_done=false;
  credits=0;error=0;
  xQueueReset(capture_queue);xQueueReset(playback_queue);
  xSemaphoreGive(lock);
}
bool passport_audio_record(void) {
  passport_audio_cancel();
  if(!audio_lock_ready())return false;
  recording=true;record_done=false;
  xSemaphoreGive(lock);return true;
}
void passport_audio_stop_record(void) {
  if(!audio_lock_ready())return;
  recording=false;xSemaphoreGive(lock);
}
bool passport_audio_capture(uint8_t *data,size_t *len) {
  if(!data||!len||!audio_lock_ready())return false;
  capture_t chunk;
  while(xQueueReceive(capture_queue,&chunk,0)==pdTRUE){
    if(chunk.generation==generation){
      memcpy(data,chunk.data,chunk.len);*len=chunk.len;
      xSemaphoreGive(lock);return true;
    }
  }
  xSemaphoreGive(lock);return false;
}
bool passport_audio_play(size_t bytes) {
  if(!bytes||bytes>16000*2*40||bytes%2)return false;
  passport_audio_cancel();
  if(!audio_lock_ready())return false;
  streaming=false;expected=bytes;received=played=0;playing=true;
  xSemaphoreGive(lock);return true;
}
bool passport_audio_play_stream(void) {
  if(!passport_audio_play(16000*2*40)||!audio_lock_ready())return false;
  streaming=true;xSemaphoreGive(lock);return true;
}
bool passport_audio_end_stream(size_t bytes) {
  if(!bytes||bytes>16000*2*40||bytes%2||!audio_lock_ready())return false;
  bool ok=playing&&streaming&&received==bytes;
  if(ok){expected=bytes;ended=true;}
  xSemaphoreGive(lock);return ok;
}
bool passport_audio_feed(const uint8_t *data,size_t len) {
  if(!data||!len||len>PASSPORT_PLAY_BYTES||len%2||!audio_lock_ready())return false;
  playback_t chunk;chunk.len=len;memcpy(chunk.data,data,len);chunk.generation=generation;
  bool ok=playing&&received+len<=expected&&xQueueSend(playback_queue,&chunk,0)==pdTRUE;
  if(ok)received+=len;
  xSemaphoreGive(lock);return ok;
}
bool passport_audio_end(void) {
  if(!audio_lock_ready())return false;
  bool ok=playing&&received==expected;
  if(ok)ended=true;
  xSemaphoreGive(lock);return ok;
}
passport_audio_status_t passport_audio_status(void) {
  passport_audio_status_t status={0};
  if(!audio_lock_ready())return status;
  status=(passport_audio_status_t){.recording=recording,.record_done=record_done,
    .play_finished=finished,.credits=credits,.error=error};
  credits=0;error=0;finished=false;
  xSemaphoreGive(lock);return status;
}
