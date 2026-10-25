// Opt-in device-only lifecycle diagnostic; no recordings are transmitted.
static bool mode_lifecycle_boot_test(void) {
  static uint8_t pcm[PASSPORT_CAPTURE_BYTES],silence[2048];
  static model_t snapshot;
  atomic_store(&desktop_suspended,true);
  for(unsigned wait=0;wait<1000;wait++){
    xSemaphoreTake(mutex,portMAX_DELAY);bool online=model.wifi_ready;xSemaphoreGive(mutex);
    if(online&&atomic_load(&desktop_pause_ready))break;
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  xSemaphoreTake(mutex,portMAX_DELAY);snapshot=model;xSemaphoreGive(mutex);
  page=PAGE_PIKO;page_locked=false;render(&snapshot,90);
#define MODE_CHECK(condition) do{if(!(condition)){ESP_LOGE("mode_test","FAILED line=%u",__LINE__);goto failed;}}while(0)
  for(unsigned cycle=0;cycle<8;cycle++){
    ESP_LOGI("mode_test","cycle=%u idle heap=%u",cycle,(unsigned)esp_get_free_heap_size());
    MODE_CHECK(audio_mode_acquire());
    ESP_LOGI("mode_test","cycle=%u audio heap=%u",cycle,(unsigned)esp_get_free_heap_size());
    MODE_CHECK(passport_audio_record());
    for(unsigned tick=0;tick<20;tick++){
      vTaskDelay(pdMS_TO_TICKS(10));size_t len;
      while(passport_audio_capture(pcm,&len)){}
      MODE_CHECK(!passport_audio_status().error);
    }
    passport_audio_stop_record();
    bool done=false;
    for(unsigned tick=0;tick<200;tick++){
      size_t len;while(passport_audio_capture(pcm,&len)){}
      passport_audio_status_t state=passport_audio_status();MODE_CHECK(!state.error);
      if(state.record_done){done=true;break;}
      vTaskDelay(pdMS_TO_TICKS(10));
    }
    MODE_CHECK(done&&passport_audio_play(sizeof(silence)));
    MODE_CHECK(passport_audio_feed(silence,sizeof(silence))&&passport_audio_end());
    done=false;
    for(unsigned tick=0;tick<200;tick++){
      passport_audio_status_t state=passport_audio_status();MODE_CHECK(!state.error);
      if(state.play_finished){done=true;break;}
      vTaskDelay(pdMS_TO_TICKS(10));
    }
    MODE_CHECK(done&&audio_mode_release());
    MODE_CHECK(pager_page_open());
    page=PAGE_PAGER;page_locked=true;render(&snapshot,90);
    vTaskDelay(pdMS_TO_TICKS(300));
    ESP_LOGI("mode_test","cycle=%u BLE heap=%u",cycle,(unsigned)esp_get_free_heap_size());
    MODE_CHECK(pager_page_close());
    page=PAGE_PIKO;page_locked=false;render(&snapshot,90);
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_LOGI("mode_test","cycle=%u released heap=%u",cycle,(unsigned)esp_get_free_heap_size());
  }
  atomic_store(&desktop_suspended,false);
  ESP_LOGI("mode_test","PASS 8 real audio/BLE lifecycle cycles");
  return true;
failed:
  audio_mode_release();pager_page_close();page=PAGE_PIKO;page_locked=false;
  atomic_store(&desktop_suspended,false);
  return false;
#undef MODE_CHECK
}
