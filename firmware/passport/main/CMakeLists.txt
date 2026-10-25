idf_component_register(SRCS "pager_page.c" "pager_ble.c" "pager_keys.c" "voice_input.c" "voice_input/adpcm.c" "main.c" "passport_audio.c" "piko_lunar.c" "piko_clock.c" "piko_chinese.c" "piko_ui_title.c" "piko_ui_small.c" "piko_seg7.c" "piko_seg7_small.c" INCLUDE_DIRS "." REQUIRES bsp esp_wifi esp_netif esp_event nvs_flash esp_http_server esp_websocket_client json esp_timer bt esp_hid app_update)

if(PIKO_MODE_LIFECYCLE_TEST)
  target_compile_definitions(${COMPONENT_LIB} PRIVATE PIKO_MODE_LIFECYCLE_TEST=1)
endif()
