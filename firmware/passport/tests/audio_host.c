#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "passport_audio.h"
#include <assert.h>
#include <stdatomic.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static atomic_uint queue_live;
typedef struct {
  pthread_mutex_t lock;
  unsigned cap, count, head;
  size_t size;
  unsigned char *data;
} queue_t;
QueueHandle_t xQueueCreate(unsigned count, size_t size) {
  queue_t *q = calloc(1, sizeof(*q));
  atomic_fetch_add(&queue_live,1);
  q->cap = count;
  q->size = size;
  q->data = calloc(count, size);
  pthread_mutex_init(&q->lock, NULL);
  return q;
}
int xQueueSend(QueueHandle_t handle, const void *data, uint32_t timeout) {
  (void)timeout;
  queue_t *q = handle;
  pthread_mutex_lock(&q->lock);
  int ok = q->count < q->cap;
  if (ok) {
    memcpy(q->data + ((q->head + q->count) % q->cap) * q->size, data, q->size);
    q->count++;
  }
  pthread_mutex_unlock(&q->lock);
  return ok;
}
int xQueueReceive(QueueHandle_t handle, void *data, uint32_t timeout) {
  queue_t *q = handle;
  for (uint32_t tick = 0;; tick++) {
    pthread_mutex_lock(&q->lock);
    int ok = q->count > 0;
    if (ok) {
      memcpy(data, q->data + q->head * q->size, q->size);
      q->head = (q->head + 1) % q->cap;
      q->count--;
    }
    pthread_mutex_unlock(&q->lock);
    if (ok || tick >= timeout)
      return ok;
    usleep(1000);
  }
}
void xQueueReset(QueueHandle_t handle) {
  queue_t *q = handle;
  pthread_mutex_lock(&q->lock);
  q->count = 0;
  q->head = 0;
  pthread_mutex_unlock(&q->lock);
}
void vQueueDelete(QueueHandle_t handle) {
  queue_t *q = handle;
  pthread_mutex_destroy(&q->lock);
  free(q->data);
  free(q);
  atomic_fetch_sub(&queue_live,1);
}
SemaphoreHandle_t xSemaphoreCreateMutex(void) {
  pthread_mutex_t *m = malloc(sizeof(*m));
  pthread_mutex_init(m, NULL);
  return m;
}
void xSemaphoreTake(SemaphoreHandle_t m, uint32_t timeout) {
  (void)timeout;
  pthread_mutex_lock(m);
}
void xSemaphoreGive(SemaphoreHandle_t m) { pthread_mutex_unlock(m); }
void vSemaphoreDelete(SemaphoreHandle_t m) {
  pthread_mutex_destroy(m);
  free(m);
}
void vTaskDelay(uint32_t ms) { usleep(ms * 1000); }
void vTaskDelete(void *task){assert(!task);pthread_exit(NULL);}
typedef struct {
  void (*fn)(void *);
  void *arg;
} task_t;
static void *launch(void *arg) {
  task_t task = *(task_t *)arg;
  free(arg);
  task.fn(task.arg);
  return NULL;
}
int xTaskCreate(void (*fn)(void *), const char *name, unsigned stack, void *arg,
                unsigned priority, void *handle) {
  (void)name;
  (void)stack;
  (void)priority;
  (void)handle;
  task_t *task = malloc(sizeof(*task));
  *task = (task_t){fn, arg};
  pthread_t thread;
  if (pthread_create(&thread, NULL, launch, task) != 0) {
    free(task);
    return 0;
  }
  pthread_detach(thread);
  return 1;
}
static atomic_bool dma_live;
esp_err_t bsp_audio_init(void) { atomic_store(&dma_live,true);return ESP_OK; }
esp_err_t passport_bsp_audio_deinit(void){atomic_store(&dma_live,false);return ESP_OK;}
esp_err_t bsp_audio_set_format(uint32_t hz, uint8_t bits, uint8_t channels) {
  assert(hz == 16000 && bits == 16 && channels == 1);
  return ESP_OK;
}
void bsp_audio_set_volume(uint8_t percent) { assert(percent <= 100); }
static atomic_bool fail_read,fail_write,block_read,read_entered;
esp_err_t bsp_audio_read(void *pcm, size_t bytes) {
  atomic_store(&read_entered,true);
  while(atomic_load(&block_read))usleep(1000);
  usleep(8000);
  if(atomic_exchange(&fail_read,false))return ESP_FAIL;
  memset(pcm, 42, bytes);
  return ESP_OK;
}
static unsigned char output[32768];
static size_t output_size;
static pthread_mutex_t output_lock = PTHREAD_MUTEX_INITIALIZER;
esp_err_t bsp_audio_write(const void *pcm, size_t bytes) {
  usleep(8000);
  if(atomic_exchange(&fail_write,false))return ESP_FAIL;
  pthread_mutex_lock(&output_lock);
  assert(output_size + bytes <= sizeof(output));
  memcpy(output + output_size, pcm, bytes);
  output_size += bytes;
  pthread_mutex_unlock(&output_lock);
  return ESP_OK;
}
static atomic_bool reader_stop;
static void *late_reader(void *unused){
  (void)unused;uint8_t buffer[PASSPORT_CAPTURE_BYTES];size_t len;
  while(!atomic_load(&reader_stop)){
    passport_audio_capture(buffer,&len);passport_audio_status();usleep(100);
  }
  return NULL;
}
static passport_audio_status_t await_complete(void) {
  passport_audio_status_t status = {0};
  unsigned credits = 0;
  for (int k = 0; k < 500; k++) {
    status = passport_audio_status();
    credits += status.credits;
    assert(!status.error);
    if (status.play_finished) {
      status.credits = credits;
      return status;
    }
    usleep(2000);
  }
  assert(!"Playback stalled");
  return status;
}
int main(void) {
  assert(passport_audio_init() == ESP_OK);
  assert(passport_audio_record());
  usleep(18000);
  passport_audio_stop_record();
  unsigned count = 0;
  unsigned char chunk[2048];
  size_t len;
  for (int k = 0; k < 100; k++) {
    passport_audio_status_t s = passport_audio_status();
    assert(!s.error);
    while (passport_audio_capture(chunk, &len)) {
      assert(len == 1024 && chunk[0] == 42);
      count++;
    }
    if (s.record_done)
      break;
    usleep(2000);
  }
  assert(count > 0);
  passport_audio_cancel();
  unsigned char expected[8192];
  for (unsigned k = 0; k < sizeof(expected); k++)
    expected[k] = (unsigned char)(k % 251);
  assert(passport_audio_play(sizeof(expected)));
  assert(!passport_audio_feed(expected, 1));
  assert(!passport_audio_feed(expected, 2049));
  for (unsigned k = 0; k < 4; k++)
    assert(passport_audio_feed(expected + k * 2048, 2048));
  assert(passport_audio_end());
  passport_audio_status_t done = await_complete();
  assert(done.credits == 4);
  pthread_mutex_lock(&output_lock);
  assert(output_size == sizeof(expected) &&
         memcmp(output, expected, sizeof(expected)) == 0);
  output_size = 0;
  pthread_mutex_unlock(&output_lock);
  // Interrupt an empty playback receive, then immediately start a new
  // generation.
  for (int round = 0; round < 12; round++) {
    assert(passport_audio_play(2048));
    usleep(5000);
    passport_audio_cancel();
    assert(passport_audio_play(2048));
    assert(passport_audio_feed(expected, 2048));
    assert(passport_audio_end());
    assert(await_complete().credits == 1);
  }
  assert(passport_audio_record());
  usleep(90000); // Consumer stalls for >3 old queue blocks; no samples lost.
  passport_audio_status_t jitter=passport_audio_status();assert(!jitter.error && jitter.recording);
  passport_audio_stop_record();
  unsigned buffered=0;
  for(unsigned k=0;k<100;k++){
    passport_audio_status_t state=passport_audio_status();assert(!state.error);
    while(passport_audio_capture(chunk,&len)){assert(len==1024 && chunk[0]==42);buffered++;}
    if(state.record_done)break;
    usleep(2000);
  }
  assert(buffered>=8);
  assert(passport_audio_record());
  passport_audio_status_t overflow={0};
  for(unsigned k=0;k<100;k++){usleep(5000);overflow=passport_audio_status();if(overflow.error)break;}
  assert(overflow.error==PASSPORT_AUDIO_CAPTURE_BACKLOG && !overflow.recording);
  atomic_store(&fail_read,true);assert(passport_audio_record());
  passport_audio_status_t io={0};
  for(unsigned k=0;k<100;k++){usleep(2000);io=passport_audio_status();if(io.error)break;}
  assert(io.error==PASSPORT_AUDIO_CAPTURE_IO);
  atomic_store(&fail_write,true);assert(passport_audio_play(2048));assert(passport_audio_feed(chunk,2048));
  for(unsigned k=0;k<100;k++){usleep(2000);io=passport_audio_status();if(io.error)break;}
  assert(io.error==PASSPORT_AUDIO_PLAY_IO);
  passport_audio_cancel();
  assert(passport_audio_play(4096));
  assert(passport_audio_feed(expected, 2048));
  assert(!passport_audio_end());
  passport_audio_cancel();
  passport_audio_cancel();
  assert(passport_audio_play_stream());
  assert(passport_audio_feed(expected, 2048));
  assert(!passport_audio_end_stream(4096));
  usleep(15000);
  assert(!passport_audio_status().play_finished);
  assert(passport_audio_feed(expected + 2048, 2048));
  assert(passport_audio_end_stream(4096));
  assert(await_complete().play_finished);
  passport_audio_cancel();
  assert(passport_audio_play_stream());
  assert(!passport_audio_end_stream(0));
  assert(!passport_audio_end_stream(16000 * 2 * 41));
  passport_audio_cancel();
  atomic_store(&read_entered,false);atomic_store(&block_read,true);
  assert(passport_audio_record());
  for(unsigned wait=0;!atomic_load(&read_entered)&&wait<100;wait++)usleep(1000);
  assert(atomic_load(&read_entered));
  assert(passport_audio_deinit()==ESP_ERR_TIMEOUT);
  assert(atomic_load(&queue_live)==2&&atomic_load(&dma_live));
  assert(passport_audio_init()==ESP_ERR_INVALID_STATE);
  atomic_store(&block_read,false);usleep(30000);
  assert(passport_audio_init()==ESP_OK&&atomic_load(&queue_live)==2);
  pthread_t reader;assert(!pthread_create(&reader,NULL,late_reader,NULL));
  for(unsigned cycle=0;cycle<40;cycle++){
    assert(passport_audio_deinit()==ESP_OK);
    assert(!atomic_load(&dma_live)&&atomic_load(&queue_live)==0);
    pthread_mutex_lock(&output_lock);output_size=0;pthread_mutex_unlock(&output_lock);
    assert(!passport_audio_record()&&!passport_audio_feed(chunk,2048));
    assert(passport_audio_deinit()==ESP_OK);
    assert(passport_audio_init()==ESP_OK);
    assert(passport_audio_init()==ESP_OK); // Idempotence, no duplicate worker/queues.
    assert(atomic_load(&dma_live)&&atomic_load(&queue_live)==2);
    assert(passport_audio_record());usleep(10000);
    if(cycle%2){passport_audio_cancel();assert(passport_audio_play(2048));assert(passport_audio_feed(chunk,2048));}
  }
  assert(passport_audio_deinit()==ESP_OK&&atomic_load(&queue_live)==0);
  atomic_store(&reader_stop,true);pthread_join(reader,NULL);
  puts("PASS: 40 audio lifecycle cycles, stop during I/O, queue/DMA release and idempotent reinit");
  puts("PASS: capture/stop, scheduling jitter, distinct I/O errors, bounded queues, ordered playback/credits, "
       "cancel/restart, overflow recovery, incomplete audio rejection");
  return 0;
}
