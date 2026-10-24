#include "bsp_battery.h"
#include "bsp_button.h"
#include "button_dispatch.h"
#include "bsp_display.h"
#include "bsp_i2c.h"
#include "cJSON.h"
#include "confirmation_gate.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_mac.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "passport_audio.h"
#include "voice_input.h"
#include "portal.h"
#include "portal_address.h"
#include "wifi_recovery.h"
#include "ui_text.h"
#include "ui_input.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FW_VERSION "piko-0.8.0"
#define PAGE_COUNT 3
LV_FONT_DECLARE(piko_chinese);
LV_FONT_DECLARE(piko_ui_title);
LV_FONT_DECLARE(piko_ui_small);
static lv_font_t title_font;
typedef struct {
  char ssid[33], password[64], host[64], code[9], token[65];
} config_t;
typedef struct {
  bool connected, authenticated, save_token, reboot, setup, wifi_ready;
  char voice_id[65], voice_stage[24], transcript[1201], reply[801],
      voice_note[241];
  bool voice_busy, voice_cancel_requested;
  char confirmation_id[33], confirmation_text[2201];
  piko_confirmation_gate_t confirmation_gate;
  int64_t voice_text_at;
} model_t;
typedef struct {
  bsp_btn_t key;
  bsp_btn_ev_t event;
  uint32_t confirmation_epoch;
} key_event_t;
static atomic_uint confirmation_epoch;
static config_t cfg;
// Separate NVS key preserves the existing Wi-Fi/token blob layout.
static atomic_uint link_mode = 1; // 0 stopped, 1 connect, 2 revoke pairing
static int64_t pairing_started_at;
static bool link_confirm, link_confirm_fresh;

static piko_wifi_recovery_t wifi_recovery;
static uint8_t setup_reason;
static model_t model;
static SemaphoreHandle_t mutex;
static QueueHandle_t keys;
static esp_websocket_client_handle_t socket_client;
static char device_id[32], boot_id[9], setup_ssid[32];
static char discovery_nonce[33];
static lv_obj_t *title, *face, *body, *footer, *status_label, *nav_label, *content_card;
static lv_obj_t *nav_dots[PAGE_COUNT];
static atomic_bool input_selected;
static bool input_controls, input_down_pressed;
static unsigned text_page_index, text_page_count=1;
static uint32_t ui_text_hash;
static int64_t ui_text_origin;
static piko_voice_key_t voice_key;
static int page;
static char receive_buf[4097];
static size_t received;
static int receive_opcode;
static bool audio_ready, voice_stop_requested, voice_stream;
static unsigned voice_sequence;
static uint64_t voice_sent;
static atomic_bool long_upload;
static int64_t voice_started;

static void copy_text(char *dst, size_t n, const char *src) {
  if (!n)
    return;
  if (!src)
    src = "";
  size_t len = strlen(src);
  if (len >= n) {
    len = n - 1;
    while (len && (((unsigned char)src[len] & 0xc0) == 0x80))
      len--;
  }
  memcpy(dst, src, len);
  dst[len] = 0;
}
static const char *str(const cJSON *obj, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}
static bool persist(void) {
  config_t copy;
  xSemaphoreTake(mutex, portMAX_DELAY);
  copy = cfg;
  xSemaphoreGive(mutex);
  nvs_handle_t h;
  esp_err_t result=nvs_open("piko",NVS_READWRITE,&h);
  if(result==ESP_OK){
    result=nvs_set_blob(h,"config",&copy,sizeof(copy));
    if(result==ESP_OK)result=nvs_set_u8(h,"link_mode",atomic_load(&link_mode));
    if(result==ESP_OK)result=nvs_commit(h);
    nvs_close(h);
  }
  return result == ESP_OK;
}
static bool send_json(cJSON *json) {
  if(!json)return false;
  char *text=cJSON_PrintUnformatted(json);
  bool ok=false;
  if(text && socket_client && esp_websocket_client_is_connected(socket_client)) {
    size_t len=strlen(text);
    ok=esp_websocket_client_send_text(socket_client,text,len,pdMS_TO_TICKS(500))==(int)len;
  }
  free(text);cJSON_Delete(json);return ok;
}
static cJSON *packet(const char *type) {
  cJSON *j = cJSON_CreateObject();
  cJSON_AddNumberToObject(j, "v", 1);
  cJSON_AddStringToObject(j, "type", type);
  return j;
}
static void hello(void) {
  config_t copy;
  xSemaphoreTake(mutex, portMAX_DELAY);
  copy = cfg;
  xSemaphoreGive(mutex);
  cJSON *j = packet("hello");
  cJSON_AddStringToObject(j, "deviceId", device_id);
  cJSON_AddStringToObject(j, "discoveryNonce", discovery_nonce);
  cJSON_AddBoolToObject(j, "disconnectRequested", atomic_load(&link_mode)==2);
  cJSON *capabilities = cJSON_AddArrayToObject(j, "capabilities");
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("voice-confirm-v1"));
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("voice-stream-v1"));
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("voice-long-upload-v1"));
  if (copy.token[0])
    cJSON_AddStringToObject(j, "token", copy.token);
  else
    cJSON_AddStringToObject(j, "pairingCode", copy.code);
  send_json(j);
}
static void receive_json(const char *text) {
  cJSON *j = cJSON_Parse(text);
  if (!j)
    return;
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, "v");
  if (!cJSON_IsNumber(v) || v->valueint != 1) {
    cJSON_Delete(j);
    return;
  }
  const char *type = str(j, "type");
  xSemaphoreTake(mutex, portMAX_DELAY);
  if (strcmp(type, "unpaired") == 0 && atomic_load(&link_mode)==2) {
    cfg.token[0]=cfg.code[0]=cfg.host[0]=0;
    atomic_store(&link_mode,0);
    model.authenticated=false;
    model.save_token=true;
    model.reboot=true;
  } else if (strcmp(type, "welcome") == 0) {
    atomic_store(&long_upload,false);
    const cJSON *caps=cJSON_GetObjectItemCaseSensitive(j,"capabilities"),*cap=NULL;
    cJSON_ArrayForEach(cap,caps){if(cJSON_IsString(cap) && strcmp(cap->valuestring,"voice-long-upload-v1")==0)atomic_store(&long_upload,true);}

    const char *token = str(j, "token");
    if (strlen(token) == 64) {
      copy_text(cfg.token, sizeof(cfg.token), token);
      cfg.code[0] = 0;
      model.save_token = true;
    }
    model.authenticated = true;
    ESP_LOGI("piko_voice","authenticated long_upload=%d",atomic_load(&long_upload));
  } else if (!atomic_load(&input_selected) && model.authenticated && model.voice_busy &&
             strcmp(str(j, "id"), model.voice_id) == 0 &&
             strncmp(type, "voice_", 6) == 0) {
    if (strcmp(type, "voice_confirmation") == 0) {
      copy_text(model.confirmation_id, sizeof(model.confirmation_id),
                str(j, "confirmationId"));
      copy_text(model.confirmation_text, sizeof(model.confirmation_text),
                str(j, "message"));
      piko_confirmation_new(
          &model.confirmation_gate,
          atomic_fetch_add(&confirmation_epoch, 1) + 1,
          cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "desktopOnly")));
      model.voice_note[0] = 0;
      model.voice_text_at = esp_timer_get_time();
      copy_text(model.voice_stage, sizeof(model.voice_stage),
                "awaiting_confirmation");
    } else if (strcmp(type, "voice_notice") == 0) {
      copy_text(model.voice_note, sizeof(model.voice_note), str(j, "message"));
      model.voice_text_at = esp_timer_get_time();
    } else if (strcmp(type, "voice_status") == 0) {
      const char *stage = str(j, "stage");
      copy_text(model.voice_stage, sizeof(model.voice_stage), stage);
      model.confirmation_id[0] = 0;
      piko_confirmation_clear(&model.confirmation_gate);
      if (strcmp(stage, "done") == 0 || strcmp(stage, "cancelled") == 0 ||
          strcmp(stage, "text_only") == 0)
        model.voice_busy = false;
      if (str(j, "message")[0])
        copy_text(model.voice_note, sizeof(model.voice_note),
                  str(j, "message"));
    } else if (strcmp(type, "voice_transcript") == 0) {
      copy_text(model.transcript, sizeof(model.transcript), str(j, "text"));
      model.voice_text_at = esp_timer_get_time();
    } else if (strcmp(type, "voice_reply") == 0) {
      copy_text(model.reply, sizeof(model.reply), str(j, "text"));
      model.voice_text_at = esp_timer_get_time();
    } else if (strcmp(type, "voice_error") == 0) {
      model.voice_busy = false;
      copy_text(model.voice_stage, sizeof(model.voice_stage), "error");
      copy_text(model.voice_note, sizeof(model.voice_note), str(j, "message"));
      passport_audio_cancel();
    } else if (strcmp(type, "voice_audio") == 0) {
      const cJSON *bytes = cJSON_GetObjectItemCaseSensitive(j, "bytes");
      voice_stream = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "stream"));
    bool ok = cJSON_IsNumber(bytes) && (voice_stream ? bytes->valuedouble == 0 : bytes->valuedouble > 0) &&
                bytes->valuedouble <= 16000 * 2 * 40 &&
                cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(
                    j, "sampleRate")) == 16000 &&
                cJSON_GetNumberValue(
                    cJSON_GetObjectItemCaseSensitive(j, "channels")) == 1 &&
                strcmp(str(j, "format"), "pcm_s16le") == 0 &&
                (voice_stream ? passport_audio_play_stream() : passport_audio_play((size_t)bytes->valuedouble));
      if (ok)
        copy_text(model.voice_stage, sizeof(model.voice_stage), "playing");
      else {
        model.voice_cancel_requested = true;
        copy_text(model.voice_note, sizeof(model.voice_note),
                  "无法播放收到的语音，请重试。");
      }
    } else if (strcmp(type, "voice_audio_end") == 0) {
    const cJSON *end_bytes = cJSON_GetObjectItemCaseSensitive(j, "bytes");
    bool complete = voice_stream ? (cJSON_IsNumber(end_bytes) && end_bytes->valuedouble > 0 && end_bytes->valuedouble <= 16000 * 2 * 40 && passport_audio_end_stream((size_t)end_bytes->valuedouble)) : passport_audio_end();
    if (!complete) {
      model.voice_cancel_requested = true;
      copy_text(model.voice_note, sizeof(model.voice_note), "语音传输不完整，请重试。");
    }
    }
  }
  xSemaphoreGive(mutex);
  cJSON_Delete(j);
}
static void websocket_event(void *arg, esp_event_base_t base, int32_t id,
                            void *data) {
  (void)arg;
  (void)base;
  esp_websocket_event_data_t *event = data;
  if (id == WEBSOCKET_EVENT_CONNECTED) {
    xSemaphoreTake(mutex, portMAX_DELAY);
    model.connected = true;
    xSemaphoreGive(mutex);
  } else if (id == WEBSOCKET_EVENT_DISCONNECTED) {
    xSemaphoreTake(mutex, portMAX_DELAY);
    model.connected = false;
    model.authenticated = false;
    model.voice_busy = false;
    copy_text(model.voice_stage, sizeof(model.voice_stage), "offline");
    if (!atomic_load(&input_selected)) passport_audio_cancel();
    xSemaphoreGive(mutex);
    received = 0;
  } else if (id == WEBSOCKET_EVENT_DATA &&
             (event->op_code == 1 || event->op_code == 2 ||
              event->op_code == 0)) {
    if (event->payload_offset == 0 &&
        (event->op_code == 1 || event->op_code == 2)) {
      received = 0;
      receive_opcode = event->op_code;
    }
    if (event->data_len < 0 ||
        received + (size_t)event->data_len >= sizeof(receive_buf)) {
      received = 0;
      return;
    }
    memcpy(receive_buf + received, event->data_ptr, event->data_len);
    received += event->data_len;
    if (event->fin &&
        event->payload_offset + event->data_len == event->payload_len) {
      receive_buf[received] = 0;
      if (receive_opcode == 1)
        receive_json(receive_buf);
      else if (receive_opcode == 2) {
        xSemaphoreTake(mutex, portMAX_DELAY);
        if (model.voice_busy && strcmp(model.voice_stage, "playing") == 0 &&
            !passport_audio_feed((const uint8_t *)receive_buf, received)) {
          model.voice_cancel_requested = true;
          copy_text(model.voice_note, sizeof(model.voice_note),
                    "播放缓冲不足，请重试。");
        }
        xSemaphoreGive(mutex);
      }
      received = 0;
    }
  }
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id,
                       void *data) {
  (void)arg;
  bool reconnect = false;
  xSemaphoreTake(mutex, portMAX_DELAY);
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    model.wifi_ready = true;
    piko_wifi_online(&wifi_recovery);
  }
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    model.wifi_ready = false;
    const wifi_event_sta_disconnected_t *event = data;
    bool auth_failed = event && (event->reason == WIFI_REASON_AUTH_FAIL ||
        event->reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
        event->reason == WIFI_REASON_HANDSHAKE_TIMEOUT);
    piko_wifi_disconnected(&wifi_recovery, esp_timer_get_time(), auth_failed);
    reconnect = !piko_wifi_recover(&wifi_recovery, esp_timer_get_time());
  }
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) reconnect = true;
  xSemaphoreGive(mutex);
  if (reconnect) esp_wifi_connect();
}
static bool portal_request(httpd_req_t *r) {
  struct sockaddr_storage local = {0};
  socklen_t len = sizeof(local);
  return getsockname(httpd_req_to_sockfd(r), (struct sockaddr *)&local, &len) ==
             0 &&
         portal_address_allowed(&local, len);
}
static esp_err_t get_portal(httpd_req_t *r) {
  if (!portal_request(r))
    return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN, "请连接设备配网热点后访问");
  httpd_resp_set_type(r, "text/html; charset=utf-8");
  return httpd_resp_send(r, PORTAL_HTML, HTTPD_RESP_USE_STRLEN);
}
static esp_err_t configure(httpd_req_t *r) {
  if (!portal_request(r))
    return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN, "请连接设备配网热点后访问");
  char content_type[64];
  if (httpd_req_get_hdr_value_str(r, "Content-Type", content_type,
                                  sizeof(content_type)) != ESP_OK ||
      strncmp(content_type, "application/json", 16) != 0)
    return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "请求格式错误，请刷新页面重试");
  if (r->content_len <= 0 || r->content_len > 512)
    return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST,
                               "配置信息无效，请检查后重试");
  char buf[513];
  int n = 0;
  while (n < r->content_len) {
    int got = httpd_req_recv(r, buf + n, r->content_len - n);
    if (got <= 0)
      return ESP_FAIL;
    n += got;
  }
  buf[n] = 0;
  cJSON *j = cJSON_Parse(buf);
  if (!j)
    return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "请求内容无效，请刷新页面重试");
  const char *ssid = str(j, "ssid"), *password = str(j, "password"),
             *host = str(j, "host"), *code = str(j, "pairingCode");
  struct in_addr addr = {0};
  bool manual = host[0] || code[0];
  bool valid = ssid[0] && strlen(ssid) <= 32 && strlen(password) <= 63;
  if (manual) {
    valid = valid && strlen(code) == 8 && inet_pton(AF_INET, host, &addr) == 1;
    uint32_t ip = ntohl(addr.s_addr);
    valid = valid && ((ip >> 24) == 10 || (ip >> 20) == 0xac1 || (ip >> 16) == 0xc0a8);
    for (int k = 0; k < 8 && valid; k++) valid = isxdigit((unsigned char)code[k]);
  }
  if (!valid) {
    cJSON_Delete(j);
    return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "请检查网络名称、密码或手动配对信息");
  }
  xSemaphoreTake(mutex, portMAX_DELAY);
  char paired_token[sizeof(cfg.token)];
  copy_text(paired_token, sizeof(paired_token), cfg.token);
  memset(&cfg, 0, sizeof(cfg));
  if (!manual) copy_text(cfg.token, sizeof(cfg.token), paired_token);
  copy_text(cfg.ssid, sizeof(cfg.ssid), ssid);
  copy_text(cfg.password, sizeof(cfg.password), password);
  copy_text(cfg.host, sizeof(cfg.host), host);
  for (int k = 0; k < 8 && code[k]; k++)
    cfg.code[k] = (char)tolower((unsigned char)code[k]);
  xSemaphoreGive(mutex);
  cJSON_Delete(j);
  if (!persist())
    return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR,
                               "设置保存失败，请重试");
  xSemaphoreTake(mutex, portMAX_DELAY);
  model.reboot = true;
  xSemaphoreGive(mutex);
  httpd_resp_set_type(r, "text/plain; charset=utf-8");
  return httpd_resp_sendstr(
      r, "已保存，设备即将重启并连接 Piko。可以切回原来的 Wi-Fi。");
}
static esp_err_t scan_networks(httpd_req_t *r) {
  if (!portal_request(r))
    return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN, "请连接设备配网热点后访问");
  wifi_scan_config_t scan = {.show_hidden = false};
  if (esp_wifi_scan_start(&scan, true) != ESP_OK)
    return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR, "网络扫描失败，请重试");
  uint16_t count = 24;
  wifi_ap_record_t *records = calloc(count, sizeof(*records));
  if (!records) { esp_wifi_clear_ap_list(); return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR, "设备内存不足，请稍后重试"); }
  esp_err_t result = esp_wifi_scan_get_ap_records(&count, records);
  cJSON *list = cJSON_CreateArray();
  if (result == ESP_OK && list) {
    for (unsigned k = 0; k < count; k++) {
      if (!records[k].ssid[0]) continue;
      bool duplicate = false;
      for (unsigned n = 0; n < k; n++)
        if (strcmp((char *)records[n].ssid, (char *)records[k].ssid) == 0) duplicate = true;
      if (duplicate) continue;
      cJSON *network = cJSON_CreateObject();
      cJSON_AddStringToObject(network, "ssid", (char *)records[k].ssid);
      cJSON_AddNumberToObject(network, "rssi", records[k].rssi);
      cJSON_AddBoolToObject(network, "open", records[k].authmode == WIFI_AUTH_OPEN);
      cJSON_AddItemToArray(list, network);
    }
  }
  free(records);
  char *json = list ? cJSON_PrintUnformatted(list) : NULL;
  cJSON_Delete(list);
  if (!json || result != ESP_OK) { free(json); return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR, "网络扫描失败，请重试"); }
  httpd_resp_set_type(r, "application/json; charset=utf-8");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  result = httpd_resp_sendstr(r, json); free(json); return result;
}

static esp_err_t setup_status(httpd_req_t *r) {
  if (!portal_request(r)) return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN, "请连接设备配网热点后访问");
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "ssid", cfg.ssid);
  cJSON_AddStringToObject(j, "error", setup_reason == PIKO_WIFI_AUTH_FAILED ?
      "Wi-Fi 认证失败，请检查密码后重新连接。" : setup_reason == PIKO_WIFI_TIMEOUT ?
      "30 秒内未能连上 Wi-Fi，请检查网络名称、密码及信号后重试。" : "");
  char *json = cJSON_PrintUnformatted(j); cJSON_Delete(j);
  if (!json) return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR, "设备内存不足，请稍后重试");
  httpd_resp_set_type(r, "application/json; charset=utf-8");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  esp_err_t result = httpd_resp_sendstr(r, json); free(json); return result;
}

static void start_setup(void) {
  model.setup = true;
  snprintf(setup_ssid, sizeof(setup_ssid), "Piko-Setup-%.6s",
           device_id + strlen(device_id) - 6);
  esp_netif_create_default_wifi_ap();
  esp_netif_create_default_wifi_sta();
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
  wifi_config_t ap = {0};
  copy_text((char *)ap.ap.ssid, sizeof(ap.ap.ssid), setup_ssid);
  ap.ap.ssid_len = strlen(setup_ssid);
  ap.ap.max_connection = 2;
  ap.ap.authmode = WIFI_AUTH_OPEN;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
  ESP_ERROR_CHECK(esp_wifi_start());
  httpd_config_t server = HTTPD_DEFAULT_CONFIG();
  server.stack_size = 6144;
  httpd_handle_t handle;
  ESP_ERROR_CHECK(httpd_start(&handle, &server));
  httpd_uri_t get = {.uri = "/", .method = HTTP_GET, .handler = get_portal};
  httpd_uri_t status = {.uri = "/setup-status", .method = HTTP_GET, .handler = setup_status};
  ESP_ERROR_CHECK(httpd_register_uri_handler(handle, &status));
  httpd_uri_t networks = {.uri = "/networks", .method = HTTP_GET, .handler = scan_networks};
  ESP_ERROR_CHECK(httpd_register_uri_handler(handle, &networks));
  httpd_uri_t post = {
      .uri = "/configure", .method = HTTP_POST, .handler = configure};
  ESP_ERROR_CHECK(httpd_register_uri_handler(handle, &get));
  ESP_ERROR_CHECK(httpd_register_uri_handler(handle, &post));
}
static void connect_desktop(void) {
  static char uri[100];
  snprintf(uri, sizeof(uri), "ws://%s:19388", cfg.host);
  esp_websocket_client_config_t config = {.uri = uri,
                                          .buffer_size = 1024,
                                          .reconnect_timeout_ms = 3000,
                                          .network_timeout_ms = 3000,
                                          .task_stack = 8192};
  socket_client = esp_websocket_client_init(&config);
  if (!socket_client)
    abort();
  ESP_ERROR_CHECK(esp_websocket_register_events(
      socket_client, WEBSOCKET_EVENT_ANY, websocket_event, NULL));
  ESP_ERROR_CHECK(esp_websocket_client_start(socket_client));
}
static void discover_desktop(void *arg) {
  (void)arg;
  uint8_t nonce[16]; esp_fill_random(nonce, sizeof(nonce));
  for (unsigned k = 0; k < sizeof(nonce); k++) snprintf(discovery_nonce + k * 2, 3, "%02x", nonce[k]);
  // Manual host/code remains available as a fallback for multicast-isolated LANs.
  if(atomic_load(&link_mode)==0){vTaskDelete(NULL);return;}
  bool connecting=false;
  if(cfg.host[0] && (cfg.code[0] || cfg.token[0])){connect_desktop();connecting=true;}
  int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) { vTaskDelete(NULL); return; }
  int enabled = 1; setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled));
  struct timeval timeout = {.tv_sec = 1};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  char request[180];
  snprintf(request, sizeof(request),
           "{\"v\":1,\"type\":\"piko-discover\",\"deviceId\":\"%s\",\"nonce\":\"%s\",\"pairRequested\":%s}",
           device_id, discovery_nonce, atomic_load(&link_mode)==1 && !cfg.token[0]?"true":"false");
  esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  while (true) {
    xSemaphoreTake(mutex, portMAX_DELAY);
    bool authenticated = model.authenticated;
    xSemaphoreGive(mutex);
    if (authenticated) { close(fd); vTaskDelete(NULL); return; }
    esp_netif_ip_info_t ip = {0};
    if (esp_netif_get_ip_info(netif, &ip) != ESP_OK || !ip.ip.addr) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
    struct sockaddr_in destination = {.sin_family = AF_INET, .sin_port = htons(19389)};
    destination.sin_addr.s_addr = ip.ip.addr | ~ip.netmask.addr;
    sendto(fd, request, strlen(request), 0, (struct sockaddr *)&destination, sizeof(destination));
    for (int tries = 0; tries < 3; tries++) {
      struct sockaddr_in peer = {0}; socklen_t peer_len = sizeof(peer); char response[384];
      int n = recvfrom(fd, response, sizeof(response) - 1, 0, (struct sockaddr *)&peer, &peer_len);
      if (n <= 0) continue;
      response[n] = 0;
      cJSON *j = cJSON_Parse(response);
      const cJSON *version = cJSON_GetObjectItemCaseSensitive(j, "v");
      const cJSON *port = cJSON_GetObjectItemCaseSensitive(j, "port");
      const char *code = str(j, "pairingCode");
      bool valid = j && cJSON_IsNumber(version) && version->valueint == 1 &&
          strcmp(str(j, "type"), "piko-service") == 0 && strcmp(str(j, "nonce"), discovery_nonce) == 0 &&
          cJSON_IsNumber(port) && port->valueint == 19388 && peer.sin_port == htons(19389) &&
          (peer.sin_addr.s_addr & ip.netmask.addr) == (ip.ip.addr & ip.netmask.addr);
      if (!cfg.token[0]) {
        valid = valid && strlen(code) == 8;
        for (unsigned k = 0; k < strlen(code) && valid; k++) valid = isxdigit((unsigned char)code[k]);
      }
      if (connecting && peer.sin_addr.s_addr != inet_addr(cfg.host)) valid = false;
      if (valid) {
        xSemaphoreTake(mutex, portMAX_DELAY);
        inet_ntop(AF_INET, &peer.sin_addr, cfg.host, sizeof(cfg.host));
        if (!cfg.token[0]) copy_text(cfg.code, sizeof(cfg.code), code);
        xSemaphoreGive(mutex);
        if (!connecting) { connect_desktop(); connecting = true; }
        // Keep discovery alive until authenticated, allowing desktop approval
        // to refresh an expired pairing code without another Wi-Fi setup.

      }
      cJSON_Delete(j);
    }
  }
}

static void start_connection(void) {
  esp_netif_create_default_wifi_sta();
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  wifi_config_t sta = {0};
  memcpy(sta.sta.ssid, cfg.ssid, strlen(cfg.ssid));
  memcpy(sta.sta.password, cfg.password, strlen(cfg.password));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                             wifi_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
  piko_wifi_begin(&wifi_recovery, esp_timer_get_time());
  ESP_ERROR_CHECK(esp_wifi_start());
  if (xTaskCreate(discover_desktop, "piko_discovery", 4096, NULL, 4, NULL) != pdPASS) abort();
}

static void button_event(bsp_btn_t key, bsp_btn_ev_t event, void *arg) {
  (void)arg;
  if (!passport_button_should_queue(key, event, atomic_load(&input_selected)))
    return;
  key_event_t item = {.key = key,
                      .event = event,
                      .confirmation_epoch = atomic_load(&confirmation_epoch)};
  xQueueSend(keys, &item, 0);
}
static cJSON *voice_packet(const char *type) {
  cJSON *j = packet(type);
  xSemaphoreTake(mutex, portMAX_DELAY);
  cJSON_AddStringToObject(j, "id", model.voice_id);
  xSemaphoreGive(mutex);
  return j;
}
static void voice_cancel(void) {
  send_json(voice_packet("voice_cancel"));
  passport_audio_cancel();
  voice_stop_requested = false;
  xSemaphoreTake(mutex, portMAX_DELAY);
  model.voice_busy = false;
  model.voice_cancel_requested = false;
  model.confirmation_id[0] = 0;
  piko_confirmation_clear(&model.confirmation_gate);
  copy_text(model.voice_stage, sizeof(model.voice_stage), "cancelled");
  xSemaphoreGive(mutex);
}
static void voice_fail(const char *message) {
  voice_cancel();
  xSemaphoreTake(mutex,portMAX_DELAY);
  copy_text(model.voice_stage,sizeof(model.voice_stage),"error");
  copy_text(model.voice_note,sizeof(model.voice_note),message);
  xSemaphoreGive(mutex);
}
static void voice_decide(bool allowed) {
  cJSON *j = voice_packet(allowed ? "voice_confirm" : "voice_reject");
  xSemaphoreTake(mutex, portMAX_DELAY);
  bool valid = model.voice_busy && model.confirmation_id[0] &&
               piko_confirmation_consume(&model.confirmation_gate);
  if (valid) {
    cJSON_AddStringToObject(j, "confirmationId", model.confirmation_id);
    model.confirmation_id[0] = 0;
    piko_confirmation_clear(&model.confirmation_gate);
    copy_text(model.voice_stage, sizeof(model.voice_stage), "working");
  }
  xSemaphoreGive(mutex);
  if (valid)
    send_json(j);
  else
    cJSON_Delete(j);
}
static void voice_begin(void) {
  xSemaphoreTake(mutex, portMAX_DELAY);
  if (!audio_ready || !model.authenticated || atomic_load(&link_mode)!=1) {
    copy_text(model.voice_note, sizeof(model.voice_note),
              audio_ready ? "请先连接电脑上的 Piko。"
                          : "音频设备未就绪，请重启检查。");
    copy_text(model.voice_stage, sizeof(model.voice_stage), "error");
    xSemaphoreGive(mutex);
    return;
  }
  if (model.voice_busy) {
    xSemaphoreGive(mutex);
    return;
  }
  snprintf(model.voice_id, sizeof(model.voice_id), "%s-voice-%u", boot_id,
           ++voice_sequence);
  model.voice_text_at = esp_timer_get_time();
  model.confirmation_id[0] = 0;
  model.confirmation_text[0] = 0;
  piko_confirmation_clear(&model.confirmation_gate);
  model.transcript[0] = 0;
  model.reply[0] = 0;
  model.voice_note[0] = 0;
  model.voice_busy = true;
  copy_text(model.voice_stage, sizeof(model.voice_stage), "listening");
  xSemaphoreGive(mutex);
  voice_stop_requested = false;
  voice_sent = 0;
  // Announce the turn before capture starts: a slow control send must not
  // fill the microphone queue before the first upload can run.
  cJSON *j=voice_packet("voice_start");
  cJSON_AddNumberToObject(j,"sampleRate",16000);
  cJSON_AddNumberToObject(j,"channels",1);
  cJSON_AddStringToObject(j,"format","pcm_s16le");
  if(!send_json(j)){voice_fail("录音连接失败，请检查电脑连接。");return;}
  voice_started=esp_timer_get_time();
  ESP_LOGI("piko_voice","capture start heap=%u buffer_ms=%u",(unsigned)esp_get_free_heap_size(),PASSPORT_CAPTURE_BLOCKS*32);
  if(!passport_audio_record()){voice_fail("麦克风启动失败。");return;}

}
static void voice_tick(void) {
  xSemaphoreTake(mutex, portMAX_DELAY);
  bool busy = model.voice_busy, cancel = model.voice_cancel_requested;
  xSemaphoreGive(mutex);
  if (cancel) {
    voice_cancel();
    return;
  }
  if (!busy) {
    voice_stop_requested = false;
    return;
  }
  passport_audio_status_t audio = passport_audio_status();
  if(audio.error){
    ESP_LOGE("piko_voice","audio error=%d uploaded=%u heap=%u",audio.error,(unsigned)voice_sent,(unsigned)esp_get_free_heap_size());
    voice_fail(audio.error==PASSPORT_AUDIO_CAPTURE_BACKLOG?"录音上传积压，请重试。":
               audio.error==PASSPORT_AUDIO_CAPTURE_IO?"麦克风读取失败，请重试或重启。":"扬声器播放失败，请重试或重启。");
    return;
  }
  if (!atomic_load(&long_upload) && audio.recording && esp_timer_get_time() - voice_started >= 12000000) {
    passport_audio_stop_record();
    voice_stop_requested = true;
  }
  static uint8_t capture[PASSPORT_CAPTURE_BYTES];
  size_t len;
  while (passport_audio_capture(capture, &len)) {
    if (!atomic_load(&long_upload) && voice_sent + len > 16000 * 2 * 12) {
      passport_audio_stop_record();
      voice_stop_requested = true;
      continue;
    }
    if (!socket_client ||
        esp_websocket_client_send_bin(socket_client, (const char *)capture, len,
                                      pdMS_TO_TICKS(200)) != (int)len) {
      voice_fail("录音上传失败，请检查电脑连接。");
      return;
    }
    voice_sent += len;
  }
  if (voice_stop_requested && audio.record_done) {
    ESP_LOGI("piko_voice","capture sent bytes=%u",(unsigned)voice_sent);
    send_json(voice_packet("voice_end"));
    voice_stop_requested = false;
    xSemaphoreTake(mutex, portMAX_DELAY);
    copy_text(model.voice_stage, sizeof(model.voice_stage), "transcribing");
    xSemaphoreGive(mutex);
  }
  if (audio.credits) {
    cJSON *j = voice_packet("voice_credit");
    cJSON_AddNumberToObject(j, "count", audio.credits);
    send_json(j);
  }
  if (audio.play_finished)
    send_json(voice_packet("voice_played"));
}
static const char *voice_stage_label(const char *stage) {
  if (strcmp(stage, "listening") == 0)
    return "录音中，松开发送";
  if (strcmp(stage, "transcribing") == 0)
    return "正在识别你说的话";
  if (strcmp(stage, "thinking") == 0)
    return "Piko 正在思考";
  if (strcmp(stage, "synthesizing") == 0)
    return "正在生成语音";
  if (strcmp(stage, "awaiting_confirmation") == 0)
    return "请核对待执行操作";
  if (strcmp(stage, "working") == 0)
    return "Piko 正在处理任务";
  if (strcmp(stage, "playing") == 0)
    return "Piko 正在说话";
  if (strcmp(stage, "text_only") == 0)
    return "文字回复，暂未能播报";
  if (strcmp(stage, "error") == 0)
    return "语音未完成";
  if (strcmp(stage, "cancelled") == 0)
    return "已取消，可重新说话";
  return "按住确认键 说话";
}
static void setup_with_reason(uint8_t reason) {
  nvs_handle_t h;
  if (nvs_open("piko", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "setup", 1);
    nvs_set_u8(h, "setup_reason", reason);
    nvs_commit(h);
    nvs_close(h);
    esp_restart();
  }
}
static void setup_on_next_boot(void) { setup_with_reason(PIKO_WIFI_OK); }

static unsigned ui_glyph_width(uint32_t cp, uint32_t next) {
  unsigned width = lv_font_get_glyph_width(&piko_chinese, cp, next);
  return width ? width : 8;
}
static void ui_page_body(const char *text, int64_t origin) {
  uint32_t hash=2166136261u;
  for(const unsigned char *p=(const unsigned char *)text;*p;p++)hash=(hash^*p)*16777619u;
  if(hash!=ui_text_hash || origin!=ui_text_origin){text_page_index=0;ui_text_hash=hash;ui_text_origin=origin;}
  text_page_count=piko_text_layout(text,196,3,UINT32_MAX,NULL,0,ui_glyph_width);
  text_page_index%=text_page_count;
  char buffer[512];piko_text_layout(text,196,3,text_page_index,buffer,sizeof(buffer),ui_glyph_width);
  lv_label_set_text(body,buffer);
}
static void ui_navigation(void) {
  const char *names[]={"语音","连接","输入"};
  for(unsigned k=0;k<PAGE_COUNT;k++){
    lv_label_set_text(nav_dots[k],names[k]);
    lv_obj_set_style_bg_opa(nav_dots[k],k==(unsigned)page?LV_OPA_COVER:LV_OPA_TRANSP,0);
    lv_obj_set_style_bg_color(nav_dots[k],lv_color_hex(0x315e49),0);
    lv_obj_set_style_text_color(nav_dots[k],lv_color_hex(k==(unsigned)page?0xffffff:0x6c786d),0);
  }
}
static void render(const model_t *m,int battery) {
  // esp_lvgl_port treats 0 as wait forever; 1ms is a bounded try-lock.
  if(!bsp_lvgl_lock(1))return;
  ui_navigation();
  lv_obj_set_hidden(face,true);
  lv_obj_set_hidden(content_card,false);
  lv_obj_set_style_text_font(face,&piko_ui_small,0);
  lv_obj_set_style_text_align(body,LV_TEXT_ALIGN_LEFT,0);
  lv_obj_set_style_text_font(body,&piko_chinese,0);
  lv_obj_align(body,LV_ALIGN_TOP_MID,0,118);
  lv_obj_align(content_card,LV_ALIGN_TOP_MID,0,106);lv_obj_set_height(content_card,126);
  lv_label_set_text(footer,"");lv_label_set_text(nav_label,"上下键切换页面");
  const char *state=atomic_load(&link_mode)==0?"未连接":atomic_load(&link_mode)==2?"等待解绑":m->authenticated?"已连接":m->wifi_ready?"寻找电脑":"连接网络中";
  if(battery>=0)lv_label_set_text_fmt(status_label,"%s · 电量 %d%%",state,battery);
  else lv_label_set_text(status_label,state);
  if(m->setup){
    lv_label_set_text(title,"连接你的 Piko");
    lv_label_set_text(status_label,setup_reason==PIKO_WIFI_AUTH_FAILED?"密码或认证失败，请重新填写":setup_reason==PIKO_WIFI_TIMEOUT?"连接超时，请检查网络":"首次连接，只需几步");
    lv_obj_set_hidden(face,false);lv_label_set_text(face,"第一步：连接设备热点");lv_obj_align(face,LV_ALIGN_TOP_MID,0,80);
    lv_obj_set_style_text_align(body,LV_TEXT_ALIGN_CENTER,0);
    lv_obj_set_style_text_font(body,&piko_ui_small,0);
    lv_label_set_text_fmt(body,"连接热点（无需密码）\n%s\n浏览器打开\n192.168.4.1",setup_ssid);
    lv_label_set_text(footer,"选择与电脑相同的无线网络");lv_label_set_text(nav_label,"保存后到连接页发起连接");
    for(unsigned k=0;k<PAGE_COUNT;k++)lv_obj_set_hidden(nav_dots[k],true);
  } else if(page==2){
    voice_input_status_t input=voice_input_status();
    lv_label_set_text(title,"随身语音输入");
    lv_label_set_text(status_label,m->wifi_ready?"无线网络已连接":"无线网络未连接");
    lv_obj_set_hidden(face,false);lv_obj_align(face,LV_ALIGN_TOP_MID,0,80);
    lv_label_set_text(face,input.recording?"正在录音":input.draining?"正在结束录音":input.selected?"已选择输入电脑":input.candidate?"请核对电脑地址":"等待语音客户端");
    char text[320];
    snprintf(text,sizeof(text),"%s\n%s",input.peer[0]?input.peer:"UDP 33333",input.error?"输入异常，请退出重试。":input_controls && !input.selected?"电脑已断开，请退出重选。":input_controls?"上键按住说话，松开结束。\n下键回车，请先核对文字。":"电脑启动语音客户端。\n确认后输入电脑光标处。");
    ui_page_body(text,0);
    lv_label_set_text(footer,input_controls?"短按确认键退出输入":"短按确认键选择这台电脑");
    lv_label_set_text(nav_label,input_controls?"请在电脑核对识别文字":"上下键切换功能");
  }else if(page==1){
    unsigned mode=atomic_load(&link_mode);
    lv_label_set_text(title,link_confirm?"解除设备配对？":"设备连接");
    lv_obj_set_hidden(face,false);lv_obj_align(face,LV_ALIGN_TOP_MID,0,80);
    lv_label_set_text(face,mode==2?"等待电脑同步解除":m->authenticated?"已连接电脑上的 Piko":mode==1?"正在寻找电脑上的 Piko":"从这里发起连接");
    ui_page_body(link_confirm?"会清除双方配对信息。\n无线网络设置会保留。":mode==2?"已停止设备业务交互。\n电脑上线后自动解绑。":mode==0?"电脑打开设备连接，\n短按确认键开始连接。\n无需在电脑重复确认。":m->authenticated?"已配对，可自动重连。\n长按确认键解除配对。":"请让电脑与设备连上\n同一无线网络，并开启\n电脑端的设备连接。",0);
    lv_label_set_text(footer,link_confirm?"短按确认解除 · 长按重新配网":mode==2?"等待电脑上线后同步":mode==0?(cfg.token[0]?"短按连接 · 长按解除":"短按确认键发起连接"):m->authenticated?"短按断开 · 长按解除":"短按停止连接 · 长按解除");
    lv_label_set_text(nav_label,mode!=0 && !m->authenticated?"长按确认键重新配网":"上下键切换功能");
  }else{
    lv_label_set_text(title,"和 Piko 聊聊");
    lv_obj_set_hidden(face,false);lv_obj_align(face,LV_ALIGN_TOP_MID,0,80);
    const char *stage=voice_stage_label(m->voice_stage);
    if(!m->voice_busy && m->reply[0] && strcmp(m->voice_stage,"error")!=0)stage="回复已完成";
    if(strcmp(m->voice_stage,"listening")==0){
      uint64_t elapsed=(esp_timer_get_time()-voice_started)/1000000;
      lv_label_set_text_fmt(face,"录音中 %02" PRIu64 ":%02" PRIu64,elapsed/60,elapsed%60);
    }else lv_label_set_text(face,stage);
    bool confirmation=strcmp(m->voice_stage,"awaiting_confirmation")==0;
    const char *text=confirmation?m->confirmation_text:strcmp(m->voice_stage,"error")==0 || (strcmp(m->voice_stage,"cancelled")==0 && m->voice_note[0])?m->voice_note:m->reply[0]?m->reply:m->voice_note[0]?m->voice_note:m->transcript[0]?m->transcript:m->authenticated?(atomic_load(&long_upload)?"按住确认键再说话，\n松开后发送。\n按住可持续录音。":"按住确认键再说话，\n松开后发送。\n录音最长十二秒。"):"请先连接电脑上的 Piko。";
    ui_page_body(text,m->voice_text_at);
    if(confirmation){
      xSemaphoreTake(mutex,portMAX_DELAY);piko_confirmation_show(&model.confirmation_gate,m->confirmation_gate.epoch);xSemaphoreGive(mutex);
      lv_label_set_text(footer,m->confirmation_gate.desktop_only?"请在电脑确认 · 长按取消":"短按确认执行 · 长按拒绝");
      lv_label_set_text_fmt(nav_label,"上下键翻页 · 第 %u / %u 页",text_page_index+1,text_page_count);
    }else{
      lv_label_set_text(footer,m->voice_busy?strcmp(m->voice_stage,"listening")==0?"正在听 · 松开确认键发送":"短按停止 · 按住重新说话":text_page_count>1?"短按翻页 · 按住确认键说话":"按住确认键说话，松开发送");
      if(text_page_count>1)lv_label_set_text_fmt(nav_label,"第 %u / %u 页 · 上下键切换",text_page_index+1,text_page_count);
    }
  }
  bsp_lvgl_unlock();
}

static void create_ui(void) {
  if(!bsp_lvgl_lock(1000))abort();
  lv_obj_t *screen=lv_screen_active();
  lv_obj_set_style_bg_color(screen,lv_color_hex(0xf6f1e7),0);
  lv_obj_set_style_text_color(screen,lv_color_hex(0x315446),0);
  lv_obj_set_style_text_font(screen,&piko_chinese,0);
  lv_obj_set_style_pad_all(screen,0,0);lv_obj_remove_flag(screen,LV_OBJ_FLAG_SCROLLABLE);
  content_card=lv_obj_create(screen);lv_obj_set_size(content_card,220,126);lv_obj_align(content_card,LV_ALIGN_TOP_MID,0,106);
  lv_obj_set_style_bg_color(content_card,lv_color_hex(0xffffff),0);lv_obj_set_style_bg_opa(content_card,LV_OPA_70,0);
  lv_obj_set_style_border_color(content_card,lv_color_hex(0xe3e5d8),0);lv_obj_set_style_border_width(content_card,1,0);lv_obj_set_style_radius(content_card,16,0);lv_obj_set_style_pad_all(content_card,0,0);lv_obj_remove_flag(content_card,LV_OBJ_FLAG_SCROLLABLE);
  title_font=piko_ui_title;title_font.fallback=&piko_chinese;
  title=lv_label_create(screen);lv_obj_set_width(title,220);lv_obj_set_style_text_font(title,&title_font,0);lv_obj_set_style_text_align(title,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(title,LV_ALIGN_TOP_MID,0,18);
  status_label=lv_label_create(screen);lv_obj_set_width(status_label,222);lv_obj_set_style_text_font(status_label,&piko_ui_small,0);lv_obj_set_style_text_color(status_label,lv_color_hex(0x70806d),0);lv_obj_set_style_text_align(status_label,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(status_label,LV_ALIGN_TOP_MID,0,52);
  face=lv_label_create(screen);lv_obj_set_style_text_font(face,&piko_ui_small,0);lv_obj_align(face,LV_ALIGN_TOP_MID,0,80);
  body=lv_label_create(screen);lv_label_set_long_mode(body,LV_LABEL_LONG_CLIP);lv_obj_set_width(body,196);lv_obj_set_style_text_line_space(body,2,0);lv_obj_set_style_text_align(body,LV_TEXT_ALIGN_LEFT,0);lv_obj_align(body,LV_ALIGN_TOP_MID,0,118);
  footer=lv_label_create(screen);lv_obj_set_width(footer,222);lv_obj_set_style_text_font(footer,&piko_ui_small,0);lv_obj_set_style_text_align(footer,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(footer,LV_ALIGN_BOTTOM_MID,0,-59);
  nav_label=lv_label_create(screen);lv_obj_set_width(nav_label,224);lv_obj_set_style_text_font(nav_label,&piko_ui_small,0);lv_obj_set_style_text_align(nav_label,LV_TEXT_ALIGN_CENTER,0);lv_obj_set_style_text_color(nav_label,lv_color_hex(0x70806d),0);lv_obj_align(nav_label,LV_ALIGN_BOTTOM_MID,0,-36);
  for(unsigned k=0;k<PAGE_COUNT;k++){
    nav_dots[k]=lv_label_create(screen);lv_obj_set_size(nav_dots[k],37,22);lv_obj_set_pos(nav_dots[k],62+39*k,289);lv_obj_set_style_text_font(nav_dots[k],&piko_ui_small,0);lv_obj_set_style_text_align(nav_dots[k],LV_TEXT_ALIGN_CENTER,0);lv_obj_set_style_radius(nav_dots[k],10,0);
  }
  bsp_lvgl_unlock();
}

static void change_link(unsigned mode) {
  voice_cancel();
  atomic_store(&link_mode,mode);
  // Empty-token revocation has no remote credential to revoke.
  xSemaphoreTake(mutex,portMAX_DELAY);
  if(mode==2 && !cfg.token[0]){cfg.code[0]=cfg.host[0]=0;atomic_store(&link_mode,0);}
  xSemaphoreGive(mutex);
  if(persist())esp_restart();
}

void app_main(void) {
  mutex = xSemaphoreCreateMutex();
  keys = xQueueCreate(8, sizeof(key_event_t));
  if (!mutex || !keys)
    abort();
  // Do not erase NVS on errors: preserve existing device data.
  ESP_ERROR_CHECK(nvs_flash_init());
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  wifi_init_config_t wifi = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&wifi));
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
  uint8_t mac[6];
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
  snprintf(device_id, sizeof(device_id), "passport-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(boot_id, sizeof(boot_id), "%08" PRIx32, esp_random());
  nvs_handle_t h;
  uint8_t force_setup = 0;
  if (nvs_open("piko", NVS_READWRITE, &h) == ESP_OK) {
    size_t n = sizeof(cfg);
    if (nvs_get_blob(h, "config", &cfg, &n) != ESP_OK || n != sizeof(cfg))
      memset(&cfg, 0, sizeof(cfg));
    nvs_get_u8(h, "setup", &force_setup);
    nvs_get_u8(h, "setup_reason", &setup_reason);
    nvs_erase_key(h, "setup_reason");
    nvs_erase_key(h, "setup");
    nvs_commit(h);
    nvs_close(h);
  }
  cfg.ssid[32] = 0;
  cfg.password[63] = 0;
  cfg.host[63] = 0;
  cfg.code[8] = 0;
  cfg.token[64] = 0;
  uint8_t saved_mode=cfg.token[0]?1:0;
  if(nvs_open("piko",NVS_READONLY,&h)==ESP_OK){nvs_get_u8(h,"link_mode",&saved_mode);nvs_close(h);}
  atomic_store(&link_mode,saved_mode<=2?saved_mode:0);
  pairing_started_at=esp_timer_get_time();
  if(atomic_load(&link_mode)!=1)page=1;
  ESP_ERROR_CHECK(bsp_i2c_init());
  ESP_ERROR_CHECK(bsp_display_init());
  if (!bsp_lvgl_init())
    abort();
  create_ui();
  bsp_display_backlight(65);
  ESP_ERROR_CHECK(bsp_button_init(button_event, NULL));
  bool battery_ok = bsp_battery_init() == ESP_OK;
  audio_ready = passport_audio_init() == ESP_OK;
  if (!cfg.ssid[0] || force_setup)
    start_setup();
  else
    start_connection();
  int64_t heartbeat_at = 0, battery_at = 0;
  int battery = -1;
  int64_t rendered_at = 0, hello_at = 0;
  while (true) {
    model_t m;
    xSemaphoreTake(mutex, portMAX_DELAY);
    m = model;
    model.save_token = false;
    xSemaphoreGive(mutex);
    // Transport callbacks may still hold internal locks: send hello from the
    // application loop, retrying until the desktop acknowledges authentication.
    int64_t hello_now = esp_timer_get_time();
    if (!m.setup && m.connected && !m.authenticated && hello_now - hello_at >= 1000000) {
      hello();
      hello_at = hello_now;
    }
    if (!m.setup && !m.reboot) {
      xSemaphoreTake(mutex, portMAX_DELAY);
      unsigned recovery = piko_wifi_recover(&wifi_recovery, esp_timer_get_time());
      xSemaphoreGive(mutex);
      if (recovery) setup_with_reason((uint8_t)recovery);
    }
    if (m.save_token && !persist()) {
      xSemaphoreTake(mutex,portMAX_DELAY);model.save_token=true;xSemaphoreGive(mutex);
      vTaskDelay(pdMS_TO_TICKS(500));continue;
    }
    if(!m.setup && atomic_load(&link_mode)==1 && !cfg.token[0] &&
       hello_now-pairing_started_at>120000000)change_link(0);
    static int64_t unpair_at;
    if(!m.setup && atomic_load(&link_mode)==2 && m.authenticated && hello_now-unpair_at>1000000){
      send_json(packet("unpair"));unpair_at=hello_now;
    }
    if (m.reboot) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      esp_restart();
    }
    key_event_t key;
    while (xQueueReceive(keys, &key, 0) == pdTRUE) {
      if (m.setup) continue;
      if(page==2 && input_controls){
        if(key.key==BSP_BTN_UP){
          if(key.event==BSP_BTN_PRESS)voice_input_press();
          if(key.event==BSP_BTN_RELEASE)voice_input_release();
        }else if(key.key==BSP_BTN_DOWN){
          if(key.event==BSP_BTN_PRESS)input_down_pressed=true;
          if(key.event==BSP_BTN_CLICK){
            if(input_down_pressed)voice_input_enter_key();
            input_down_pressed=false;
          }
        }else if(key.key==BSP_BTN_OK && key.event==BSP_BTN_CLICK){
          voice_input_close();voice_input_open();
          input_controls=input_down_pressed=false;
        }
        continue;
      }
      if(page==2 && key.key==BSP_BTN_OK){
        if(key.event==BSP_BTN_CLICK && m.wifi_ready){
          if(!audio_ready)audio_ready=passport_audio_init()==ESP_OK;
          if(audio_ready)input_controls=voice_input_select();
        }
        continue;
      }
      xSemaphoreTake(mutex, portMAX_DELAY);
      bool voice_busy = model.voice_busy;
      char voice_stage[24];
      copy_text(voice_stage, sizeof(voice_stage), model.voice_stage);
      xSemaphoreGive(mutex);
      if (key.key != BSP_BTN_OK && key.event == BSP_BTN_CLICK) {
        if(page==0 && strcmp(voice_stage,"awaiting_confirmation")==0){
          text_page_index=(text_page_index+text_page_count+(key.key==BSP_BTN_UP?-1:1))%text_page_count;
          continue;
        }
        piko_voice_key_reset(&voice_key);
        text_page_index=0;

        if (page == 0 && voice_busy)
          voice_cancel();
        if (link_confirm) {
          link_confirm=false;
        } else {
          if(page==2)voice_input_close();
          page = (page + (key.key == BSP_BTN_UP ? PAGE_COUNT-1 : 1)) % PAGE_COUNT;
          atomic_store(&input_selected,page==2);
          if(page==2){input_controls=input_down_pressed=false;voice_input_open();}
        }
      }
      if (key.key == BSP_BTN_OK) {
        if(page==1){
          unsigned mode=atomic_load(&link_mode);
          if(link_confirm){
            if(key.event==BSP_BTN_PRESS)link_confirm_fresh=true;
            if(key.event==BSP_BTN_CLICK && link_confirm_fresh)change_link(2);
            // Long press re-setup stays reachable for paired devices, which
            // lost the companion page's entry point.
            else if(key.event==BSP_BTN_LONG)setup_on_next_boot();
          }else if(mode!=2){
            if(key.event==BSP_BTN_LONG && (mode==1 || cfg.token[0])){link_confirm=true;link_confirm_fresh=false;}
            // Unpaired devices keep long-press re-setup: without the companion
            // page this is the only manual path back to provisioning.
            else if(key.event==BSP_BTN_LONG && !cfg.token[0])setup_on_next_boot();
            if(key.event==BSP_BTN_CLICK)change_link(mode==0?1:0);
          }
          continue;
        }

        if (page == 0) {
          if (strcmp(voice_stage, "awaiting_confirmation") == 0) {
            piko_voice_key_reset(&voice_key);
            xSemaphoreTake(mutex, portMAX_DELAY);
            bool desktop = model.confirmation_gate.desktop_only;
            if (key.event == BSP_BTN_PRESS)
              piko_confirmation_press(&model.confirmation_gate,
                                      key.confirmation_epoch);
            xSemaphoreGive(mutex);
            if (key.event == BSP_BTN_CLICK && !desktop)
              voice_decide(true);
            else if (key.event == BSP_BTN_LONG) {
              if (desktop)
                voice_cancel();
              else
                voice_decide(false);
            }
            continue;
          }
          if (key.event == BSP_BTN_PRESS) {
            bool interrupted=voice_busy && strcmp(voice_stage,"listening")!=0;
            if(interrupted)voice_cancel();
            piko_voice_key_press(&voice_key,esp_timer_get_time(),interrupted);
          } else if (key.event == BSP_BTN_RELEASE) {
            bool recorded=piko_voice_key_release(&voice_key);
            if(recorded && voice_busy && strcmp(voice_stage,"listening")==0){passport_audio_stop_record();voice_stop_requested=true;}
          } else if(key.event==BSP_BTN_CLICK && piko_voice_key_click(&voice_key)) {
            if(text_page_count>1)text_page_index=(text_page_index+1)%text_page_count;
          }
          continue;
        }
      }
    }
    int64_t now = esp_timer_get_time();
    if(!m.setup && page==0 && piko_voice_key_tick(&voice_key,now))voice_begin();
    if (battery_ok && !m.voice_busy && now - battery_at > 10000000) {
      battery = bsp_battery_soc();
      battery_at = now;
    }
    if (m.authenticated && strcmp(m.voice_stage,"listening")!=0 && now - heartbeat_at > 5000000) {
      cJSON *j = packet("heartbeat");
      cJSON_AddNumberToObject(j, "battery", battery);
      cJSON_AddStringToObject(j, "firmware", FW_VERSION);
      send_json(j);
      heartbeat_at = now;
    }
    if(page==2)voice_input_tick(m.wifi_ready && !m.setup);
    else voice_tick();
    if (now - rendered_at >= 100000) {
      render(&m, battery);
      rendered_at = now;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
