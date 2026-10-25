#include "bsp_battery.h"
#include "bsp_audio.h"
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
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "pager_page.h"
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
#include "ui_controls.h"
#include "piko_lunar.h"
#include "piko_clock.h"
#include "ws_receive.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define FW_VERSION "piko-0.11.0"
#define PAGE_COUNT 6
#define PIKO_BG 0xf6f1e7
#define PIKO_INK 0x315446
#define PIKO_MUTED 0x70806d
#define PIKO_DISABLED 0xaab0a5
#define PIKO_ACCENT 0x315e49
#define PIKO_CARD 0xffffff
#define PIKO_CARD_BORDER 0xe3e5d8
enum { PAGE_INPUT = 0, PAGE_PIKO = 1, PAGE_CALENDAR = 2, PAGE_CLOCK = 3, PAGE_SETTINGS = 4, PAGE_PAGER = 5 };
enum { VIEW_MAIN, VIEW_LINK, VIEW_REPRO };
LV_FONT_DECLARE(piko_chinese);
LV_FONT_DECLARE(piko_ui_title);
LV_FONT_DECLARE(piko_ui_small);
LV_FONT_DECLARE(piko_seg7);
LV_FONT_DECLARE(piko_seg7_small);
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
static uint8_t volume_level=2;
static const uint8_t volume_percent[]={0,25,50,75,100};
typedef struct {
  bsp_btn_t key;
  bsp_btn_ev_t event;
  uint32_t confirmation_epoch;
} key_event_t;
static atomic_uint confirmation_epoch;
static config_t cfg;
// Separate NVS key preserves the existing Wi-Fi/token blob layout.
static atomic_uint link_mode = 1; // 0 stopped, 1 connect, 2 revoke pairing
static bool link_confirm, link_confirm_fresh;

static piko_wifi_recovery_t wifi_recovery;
static uint8_t setup_reason;
static model_t model;
static SemaphoreHandle_t mutex;
static SemaphoreHandle_t socket_mutex;
static QueueHandle_t keys;
static esp_websocket_client_handle_t socket_client;
static char device_id[32], boot_id[9], setup_ssid[32];
static char discovery_nonce[33];
static lv_obj_t *status_wifi, *status_battery, *status_pct, *status_clock;
static lv_obj_t *title, *notice;
static lv_obj_t *zone_mic, *zone_min, *zone_card, *zone_menu;
static lv_obj_t *mic_ring[2], *mic_box, *mic_cap, *mic_arc, *mic_stem,
    *mic_base, *mic_big, *mic_sub;
static lv_obj_t *min_icon, *min_big, *min_sub;
static lv_obj_t *card_panel, *card_text, *card_page;
static lv_obj_t *menu_row[2], *menu_icon[2], *menu_name[2], *menu_value[2];
static lv_obj_t *zone_clk, *clk_lcd, *clk_menu_box, *clk_bbar, *clk_bfill;
static lv_obj_t *clk_ghost, *clk_time_label, *clk_sec_label;
static lv_obj_t *clk_wk[7], *clk_moon, *clk_moon_disc, *clk_batt[5];
static lv_obj_t *clk_brand_sub, *clk_wt, *clk_lunar, *clk_date, *clk_doy, *clk_temp;
static lv_obj_t *clk_menu_row_obj[2], *clk_menu_val[2];
static const uint8_t clk_bright_pct[] = {5, 25, 50, 75, 100};
static uint8_t clk_bright = 3, clk_idle_mode = 1, clk_menu_open, clk_menu_row, clk_screen_off, clk_last_sec = 99;
static int64_t clk_activity_at;
static bool clk_wake_suppress;
static bool pager_start_failed;
static bool clk_click_suppressed;
static int clk_direction;
static int64_t clk_repeat_at, clk_bright_until;
static lv_obj_t *zone_cal, *cal_today_box, *cal_month_box, *cal_ring;
static lv_obj_t *cal_d_big, *cal_d_line, *cal_d_jie, *cal_d_yi, *cal_d_ji, *cal_d_pz;
static lv_obj_t *cal_m_cell[42];
static uint8_t cal_view;  // 0 今日黄历 1 月历
static bool cal_has_date, cal_click_suppressed;
static int cal_year, cal_month, cal_day, cal_direction;
static int64_t cal_repeat_at;
static lv_obj_t *hint_label, *nav_bar, *nav_dots[PAGE_COUNT], *volume_bar;
static uint8_t settings_view, menu_selected;
static bool page_locked;
static atomic_bool volume_controls;
static int volume_direction;
static bool volume_click_suppressed,input_down_long;
static int64_t volume_repeat_at, volume_notice_until;
static uint32_t confirmation_seen_epoch;
static uint64_t confirmation_pages_seen;
static int64_t settings_error_until;
static bool mic_anim_on, input_prev_rec;
static int64_t input_rec_started;
static atomic_bool muted_pending;
static atomic_bool input_selected;
static atomic_bool desktop_suspended,desktop_pause_ready=true;
static unsigned text_page_index, text_page_count=1;
static uint32_t ui_text_hash;
static int64_t ui_text_origin;
static piko_voice_key_t voice_key;
/* Screen state is independent of page, audio and network activity. */
static bool screen_off;
enum { SCREEN_BACKLIGHT_PERCENT = 65 };
static int page;
static char receive_buf[4097];
static size_t received;
static piko_ws_receive_t receive_state;
static bool audio_ready, voice_stop_requested, voice_stream;
static bool audio_start_failed;
static unsigned voice_sequence,chat_session_sequence;
static char chat_session[65];
static int64_t chat_session_started;
static uint64_t voice_sent;
static atomic_bool long_upload;
static int64_t voice_started;
static int64_t voice_end_sent_at;

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
  xSemaphoreTake(socket_mutex,portMAX_DELAY);
  if(text && socket_client && esp_websocket_client_is_connected(socket_client)) {
    size_t len=strlen(text);
    ok=esp_websocket_client_send_text(socket_client,text,len,pdMS_TO_TICKS(500))==(int)len;
  }
  xSemaphoreGive(socket_mutex);
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
  if (voice_end_sent_at && strncmp(type, "voice_", 6) == 0)
    ESP_LOGI("piko_voice", "reply %s +%lldms", type,
             (long long)((esp_timer_get_time() - voice_end_sent_at) / 1000));
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
    } else if (strcmp(type,"voice_confirmation_resolved")==0 && model.confirmation_id[0] &&
               strcmp(str(j,"confirmationId"),model.confirmation_id)==0){
      model.confirmation_id[0]=0;piko_confirmation_clear(&model.confirmation_gate);
      copy_text(model.voice_stage,sizeof(model.voice_stage),"working");
    } else if (strcmp(type, "voice_status") == 0 &&
               !piko_confirmation_holds_status(model.confirmation_id[0]!=0,str(j,"stage"))) {
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
      if (str(j, "message")[0])
        copy_text(model.voice_note, sizeof(model.voice_note),
                  str(j, "message"));
      passport_audio_cancel();
    } else if (strcmp(type, "voice_audio") == 0) {
      const cJSON *bytes = cJSON_GetObjectItemCaseSensitive(j, "bytes");
      voice_stream = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "stream"));
    bool valid = cJSON_IsNumber(bytes) && (voice_stream ? bytes->valuedouble == 0 : bytes->valuedouble > 0) &&
                bytes->valuedouble <= 16000 * 2 * 40 &&
                cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(
                    j, "sampleRate")) == 16000 &&
                cJSON_GetNumberValue(
                    cJSON_GetObjectItemCaseSensitive(j, "channels")) == 1 &&
                strcmp(str(j, "format"), "pcm_s16le") == 0;
      if (valid && volume_level==0) {
        // 设备端静音：不驱动扬声器，但照常向电脑回执播报完成，流程继续。
        passport_audio_cancel();
        copy_text(model.voice_stage, sizeof(model.voice_stage), "text_only");
        atomic_store(&muted_pending, true);
      } else {
        bool ok = valid &&
            (voice_stream ? passport_audio_play_stream() : passport_audio_play((size_t)bytes->valuedouble));
        if (ok)
          copy_text(model.voice_stage, sizeof(model.voice_stage), "playing");
        else {
          model.voice_cancel_requested = true;
          copy_text(model.voice_note, sizeof(model.voice_note),
                    "无法播放收到的语音，请重试。");
        }
      }
    } else if (strcmp(type, "voice_audio_end") == 0) {
    if (strcmp(model.voice_stage,"playing")==0) {
    const cJSON *end_bytes = cJSON_GetObjectItemCaseSensitive(j, "bytes");
    bool complete = voice_stream ? (cJSON_IsNumber(end_bytes) && end_bytes->valuedouble > 0 && end_bytes->valuedouble <= 16000 * 2 * 40 && passport_audio_end_stream((size_t)end_bytes->valuedouble)) : passport_audio_end();
    if (!complete) {
      model.voice_cancel_requested = true;
      copy_text(model.voice_note, sizeof(model.voice_note), "语音传输不完整，请重试。");
    }
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
    receive_state = (piko_ws_receive_t){0};
  } else if (id == WEBSOCKET_EVENT_DATA &&
             (event->op_code == 1 || event->op_code == 2 ||
              event->op_code == 0)) {
    if (piko_ws_receive(&receive_state, receive_buf, sizeof(receive_buf),
            event->op_code, event->payload_offset, event->payload_len,
            event->fin, event->data_ptr, event->data_len)) {
      received = receive_state.used;
      receive_buf[received] = 0;
      if (receive_state.opcode == 1)
        receive_json(receive_buf);
      else if (receive_state.opcode == 2) {
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
static bool sntp_started;
static void wifi_event(void *arg, esp_event_base_t base, int32_t id,
                       void *data) {
  (void)arg;
  bool reconnect = false;
  xSemaphoreTake(mutex, portMAX_DELAY);
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    model.wifi_ready = true;
    piko_wifi_online(&wifi_recovery);
    if (!sntp_started) {
      sntp_started = true;
      setenv("TZ", "CST-8", 1);
      tzset();
      esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
      esp_sntp_setservername(0, "ntp.aliyun.com");
      esp_sntp_setservername(1, "pool.ntp.org");
      esp_sntp_init();
    }
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
  if (getsockname(httpd_req_to_sockfd(r), (struct sockaddr *)&local, &len) != 0) {
    ESP_LOGW("piko_setup", "Cannot read local address for %s", r->uri);
    return false;
  }
  bool allowed = portal_address_allowed(&local, len);
  if (!allowed)
    ESP_LOGW("piko_setup", "Rejected %s on address family %d", r->uri,
             (int)local.ss_family);
  return allowed;
}
static esp_err_t get_portal(httpd_req_t *r) {
  ESP_LOGI("piko_setup", "GET %s", r->uri);
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

static void setup_network_event(void *arg, esp_event_base_t base, int32_t id,
                                void *data) {
  esp_netif_t *ap_netif = arg;
  if (base == WIFI_EVENT && id == WIFI_EVENT_AP_START) {
    esp_netif_dhcp_status_t status;
    ESP_ERROR_CHECK(esp_netif_dhcps_get_status(ap_netif, &status));
    if (status != ESP_NETIF_DHCP_STARTED)
      ESP_ERROR_CHECK(esp_netif_dhcps_start(ap_netif));
    ESP_LOGI("piko_setup", "AP started; DHCP server active at 192.168.4.1");
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
    ESP_LOGI("piko_setup", "Client joined setup hotspot; waiting for DHCP");
  } else if (base == IP_EVENT && id == IP_EVENT_AP_STAIPASSIGNED) {
    const ip_event_ap_staipassigned_t *event = data;
    ESP_LOGI("piko_setup", "DHCP assigned " IPSTR, IP2STR(&event->ip));
  }
}

static void start_setup(void) {
  model.setup = true;
  snprintf(setup_ssid, sizeof(setup_ssid), "Piko-Setup-%.6s",
           device_id + strlen(device_id) - 6);
  esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
  ESP_ERROR_CHECK(ap_netif ? ESP_OK : ESP_ERR_NO_MEM);
  ESP_ERROR_CHECK(esp_netif_create_default_wifi_sta() ? ESP_OK : ESP_ERR_NO_MEM);
  // Keep the advertised portal address and DHCP subnet in sync explicitly.
  esp_err_t stopped = esp_netif_dhcps_stop(ap_netif);
  if (stopped != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED)
    ESP_ERROR_CHECK(stopped);
  esp_netif_ip_info_t ap_ip = {0};
  IP4_ADDR(&ap_ip.ip, 192, 168, 4, 1);
  IP4_ADDR(&ap_ip.gw, 192, 168, 4, 1);
  IP4_ADDR(&ap_ip.netmask, 255, 255, 255, 0);
  ESP_ERROR_CHECK(esp_netif_set_ip_info(ap_netif, &ap_ip));
  // Re-arm DHCP before the interface comes up; AP_START verifies it started.
  ESP_ERROR_CHECK(esp_netif_dhcps_start(ap_netif));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_START,
                                            setup_network_event, ap_netif));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STACONNECTED,
                                            setup_network_event, ap_netif));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED,
                                            setup_network_event, ap_netif));
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
  // Mobile browsers keep multiple connections open. Reclaim idle sessions
  // when full, and leave socket descriptors available for other services.
  server.max_open_sockets = 4;
  server.lru_purge_enable = true;
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
  ESP_LOGI("piko_setup", "Portal ready: SSID=%s URL=http://192.168.4.1/ sockets=%u",
           setup_ssid, (unsigned)server.max_open_sockets);
}
// Only the discovery worker creates/stops clients. UI sends use socket_mutex.
static void disconnect_desktop(void) {
  if(!socket_client)return;
  esp_websocket_client_stop(socket_client);
  xSemaphoreTake(socket_mutex,portMAX_DELAY);
  esp_websocket_client_destroy(socket_client);
  socket_client=NULL;
  xSemaphoreGive(socket_mutex);
  xSemaphoreTake(mutex,portMAX_DELAY);
  model.connected=model.authenticated=model.voice_busy=false;
  copy_text(model.voice_stage,sizeof(model.voice_stage),"idle");
  xSemaphoreGive(mutex);
}
static bool connect_desktop(void) {
  static char uri[100];
  snprintf(uri,sizeof(uri),"ws://%s:19388",cfg.host);
  esp_websocket_client_config_t config={.uri=uri,.buffer_size=1024,
    .reconnect_timeout_ms=3000,.network_timeout_ms=3000,.task_stack=8192};
  xSemaphoreTake(socket_mutex,portMAX_DELAY);
  socket_client=esp_websocket_client_init(&config);
  xSemaphoreGive(socket_mutex);
  if(!socket_client)return false;
  esp_err_t result=esp_websocket_register_events(socket_client,WEBSOCKET_EVENT_ANY,websocket_event,NULL);
  if(result==ESP_OK)result=esp_websocket_client_start(socket_client);
  if(result!=ESP_OK){
    ESP_LOGW("piko","Desktop connection start failed: %s",esp_err_to_name(result));
    disconnect_desktop();return false;
  }
  return true;
}

static void discover_desktop(void *arg) {
  (void)arg;
  uint8_t nonce[16]; esp_fill_random(nonce, sizeof(nonce));
  for (unsigned k = 0; k < sizeof(nonce); k++) snprintf(discovery_nonce + k * 2, 3, "%02x", nonce[k]);
  bool connecting=false;
  int fd=-1;
  char request[180];
  snprintf(request, sizeof(request),
           "{\"v\":1,\"type\":\"piko-discover\",\"deviceId\":\"%s\",\"nonce\":\"%s\",\"pairRequested\":%s}",
           device_id, discovery_nonce, atomic_load(&link_mode)==1 && !cfg.token[0]?"true":"false");
  esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  while (true) {
    xSemaphoreTake(mutex, portMAX_DELAY);
    bool authenticated = model.authenticated;
    xSemaphoreGive(mutex);
    bool paused=atomic_load(&desktop_suspended) || atomic_load(&link_mode)==0;
    if(paused){
      if(connecting || socket_client){
        disconnect_desktop();connecting=false;
        ESP_LOGI("piko","Desktop paused, heap=%u",(unsigned)esp_get_free_heap_size());
      }
      if(fd>=0){close(fd);fd=-1;}
      atomic_store(&desktop_pause_ready,true);
      vTaskDelay(pdMS_TO_TICKS(200));continue;
    }
    atomic_store(&desktop_pause_ready,false);
    if(!connecting && cfg.host[0] && (cfg.code[0] || cfg.token[0]))
      connecting=connect_desktop();
    if(authenticated){
      if(fd>=0){close(fd);fd=-1;}
      vTaskDelay(pdMS_TO_TICKS(200));continue;
    }
    if(fd<0){
      fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
      if(fd<0){vTaskDelay(pdMS_TO_TICKS(1000));continue;}
      int yes=1;
      setsockopt(fd,SOL_SOCKET,SO_BROADCAST,&yes,sizeof(yes));
      struct timeval timeout={.tv_sec=0,.tv_usec=200000};
      setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    }
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
        if (!connecting && !atomic_load(&input_selected)) connecting=connect_desktop();
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
  atomic_store(&desktop_pause_ready,false);
  if (xTaskCreate(discover_desktop, "piko_discovery", 4096, NULL, 4, NULL) != pdPASS) abort();
}

static void button_event(bsp_btn_t key, bsp_btn_ev_t event, void *arg) {
  (void)arg;
  if (!passport_button_should_queue(key, event, (atomic_load(&input_selected)||atomic_load(&volume_controls))))
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
  passport_audio_cancel();
  voice_stop_requested = false;
  xSemaphoreTake(mutex, portMAX_DELAY);
  model.voice_busy = false;
  model.voice_cancel_requested = false;
  model.confirmation_id[0] = 0;
  piko_confirmation_clear(&model.confirmation_gate);
  copy_text(model.voice_stage, sizeof(model.voice_stage), "cancelled");
  xSemaphoreGive(mutex);
  send_json(voice_packet("voice_cancel"));
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
  voice_end_sent_at = 0;
  // Announce the turn before capture starts: a slow control send must not
  // fill the microphone queue before the first upload can run.
  cJSON *j=voice_packet("voice_start");
  cJSON_AddStringToObject(j,"sessionId",chat_session);
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
  // Catch up after display/network jitter without monopolizing the main loop.
  // A fixed two-block quota can fall behind even when the socket is writable.
  const int64_t upload_deadline=esp_timer_get_time()+40000;
  bool capture_drained = false;
  for (unsigned block = 0; block < PASSPORT_CAPTURE_BLOCKS; block++) {
    int64_t remaining_us=upload_deadline-esp_timer_get_time();
    if(remaining_us<=0)break;
    if (!passport_audio_capture(capture, &len)) {
      capture_drained = true;
      break;
    }
    if (!atomic_load(&long_upload) && voice_sent + len > 16000 * 2 * 12) {
      passport_audio_stop_record();
      voice_stop_requested = true;
      continue;
    }
    // The slice budget controls yielding, not a frame's transport timeout.
    // 200ms tolerates Wi-Fi jitter within the 512ms capture queue. Do not
    // shrink a frame timeout to 1ms just because its slice is nearly over.
    int written=socket_client ? esp_websocket_client_send_bin(socket_client,
        (const char *)capture,len,pdMS_TO_TICKS(200)) : -1;
      bool upload_connected=socket_client && esp_websocket_client_is_connected(socket_client);
      xSemaphoreGive(socket_mutex);
    if (written != (int)len) {
      ESP_LOGE("piko_voice","upload failed result=%d expected=%u uploaded=%u connected=%d",
          written,(unsigned)len,(unsigned)voice_sent,
          upload_connected);
      // Resending a possibly partial WebSocket frame can corrupt the stream.
      voice_fail("录音上传失败，请检查电脑连接。");
      return;
    }
    voice_sent += len;
  }
  if (voice_stop_requested && audio.record_done && capture_drained) {
    ESP_LOGI("piko_voice","capture sent bytes=%u",(unsigned)voice_sent);
    if(!send_json(voice_packet("voice_end"))){
      voice_fail("录音结束发送失败，请检查电脑连接。");
      return;
    }
    voice_end_sent_at = esp_timer_get_time();
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
  if (atomic_exchange(&muted_pending, false))
    send_json(voice_packet("voice_played"));
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
  text_page_count=piko_text_layout(text,168,3,UINT32_MAX,NULL,0,ui_glyph_width);
  text_page_index%=text_page_count;
  char buffer[512];piko_text_layout(text,168,3,text_page_index,buffer,sizeof(buffer),ui_glyph_width);
  lv_label_set_text(card_text,buffer);
}
static bool settings_save(void) {
  nvs_handle_t h;
  if(nvs_open("piko",NVS_READWRITE,&h)!=ESP_OK)return false;
  esp_err_t result=nvs_set_u8(h,"volume5",volume_level);
  if(result==ESP_OK)result=nvs_commit(h);
  nvs_close(h);
  return result==ESP_OK;
}
static void apply_volume(void) {
  bsp_audio_set_volume(volume_percent[volume_level]);
}
static bool audio_mode_acquire(void) {
  if(audio_ready)return true;
  esp_err_t result=passport_audio_init();
  audio_start_failed=result!=ESP_OK;
  if(audio_start_failed){ESP_LOGE("piko","Audio init failed: %s",esp_err_to_name(result));return false;}
  audio_ready=true;apply_volume();
  ESP_LOGI("piko","Audio acquired heap=%u",(unsigned)esp_get_free_heap_size());
  return true;
}
static bool audio_mode_release(void) {
  audio_ready=false;
  esp_err_t result=passport_audio_deinit();
  audio_start_failed=result!=ESP_OK;
  if(audio_start_failed){ESP_LOGE("piko","Audio release failed: %s",esp_err_to_name(result));return false;}
  ESP_LOGI("piko","Audio released heap=%u",(unsigned)esp_get_free_heap_size());
  return true;
}
static void adjust_volume(bool up) {
  uint8_t previous=volume_level;
  volume_level=(uint8_t)piko_volume_step(volume_level,up);
  volume_notice_until=esp_timer_get_time()+1800000;
  if(volume_level==previous)return;
  if(!settings_save()){
    volume_level=previous;
    settings_error_until=esp_timer_get_time()+3000000;
  }
  apply_volume();
}
// Rings animate size/position directly: transform-scale layers exceed the
// esp_lvgl_port draw buffer on this panel and drop frames intermittently.
static void ring_cb(void *var, int32_t v) {
  lv_obj_t *o = var;
  int32_t s = 56 + v * 24 / 100;
  lv_obj_set_size(o, s, s);
  lv_obj_set_pos(o, 120 - s / 2, 28 - s / 2);
  lv_obj_set_style_opa(o, 120 - v * 120 / 100, 0);
}
static void mic_anim_start(void) {
  for (unsigned k = 0; k < 2; k++) {
    lv_anim_t a; lv_anim_init(&a);
    lv_anim_set_var(&a, mic_ring[k]);
    lv_anim_set_exec_cb(&a, ring_cb);
    lv_anim_set_values(&a, 0, 100);
    lv_anim_set_duration(&a, 1800);
    lv_anim_set_delay(&a, k ? 900 : 0);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&a);
  }
}
static void mic_anim_stop(void) {
  for (unsigned k = 0; k < 2; k++) {
    lv_anim_delete(mic_ring[k], ring_cb);
    lv_obj_set_size(mic_ring[k], 56, 56);
    lv_obj_set_pos(mic_ring[k], 92, 0);
    lv_obj_set_style_opa(mic_ring[k], 0, 0);
  }
}
static void mic_look(bool rec) {
  lv_color_t fg = rec ? lv_color_hex(PIKO_CARD) : lv_color_hex(PIKO_ACCENT);
  lv_obj_set_style_bg_opa(mic_box, rec ? LV_OPA_COVER : LV_OPA_10, 0);
  lv_obj_set_style_bg_color(mic_cap, fg, 0);
  lv_obj_set_style_bg_color(mic_stem, fg, 0);
  lv_obj_set_style_bg_color(mic_base, fg, 0);
  lv_obj_set_style_arc_color(mic_arc, fg, 0);
}
static void mic_anim_pause(void) {
  if (zone_mic && mic_anim_on) { mic_anim_on = false; mic_anim_stop(); }
}
enum {UI_MIC,UI_MIN,UI_CARD,UI_MENU,UI_CAL,UI_CLK,UI_PAGER,UI_NONE};
static void show_zone(unsigned kind);

static void show_mic(bool rec, const char *big, const char *sub) {
  show_zone(UI_MIC);
  if (rec != mic_anim_on) {
    mic_anim_on = rec;
    if (rec) mic_anim_start(); else mic_anim_stop();
  }
  mic_look(rec);
  lv_label_set_text(mic_big, big);
  lv_label_set_text(mic_sub, sub);
}
static void show_min(const char *icon, const char *big, const char *sub) {
  show_zone(UI_MIN);
  mic_anim_pause();
  lv_label_set_text(min_icon, icon);
  lv_label_set_text(min_big, big);
  lv_label_set_text(min_sub, sub);
}
static void show_card(const char *text, int64_t origin) {
  show_zone(UI_CARD);
  mic_anim_pause();
  ui_page_body(text, origin);
  lv_label_set_text_fmt(card_page, "%u/%u", text_page_index + 1, text_page_count);
  lv_obj_set_hidden(card_page, text_page_count <= 1);
}
static void show_menu(void) {
  static const char *names[]={"Wi-Fi 网络","电脑配对"};
  static const char *icons[]={LV_SYMBOL_WIFI,LV_SYMBOL_DRIVE};
  show_zone(UI_MENU);mic_anim_pause();
  for(unsigned k=0;k<2;k++){
    lv_label_set_text(menu_icon[k],icons[k]);
    lv_label_set_text(menu_name[k],names[k]);
    lv_label_set_text(menu_value[k],"");
    lv_obj_set_style_bg_opa(menu_row[k],page_locked&&k==menu_selected?LV_OPA_10:LV_OPA_TRANSP,0);
  }
}
// —— 日历页：聚焦日期是唯一状态，今日层与月历层都围绕它渲染。——
static void cal_today(int *y,int *m,int *d) {
  time_t nowt=time(NULL);
  if(nowt<=1700000000){cal_has_date=false;return;}
  struct tm tm_info;
  localtime_r(&nowt,&tm_info);
  *y=tm_info.tm_year+1900;*m=tm_info.tm_mon+1;*d=tm_info.tm_mday;
  cal_has_date=true;
}
static void cal_step(int delta) {
  if(!cal_has_date)return;
  struct tm t={0};
  t.tm_year=cal_year-1900;t.tm_mon=cal_month-1;t.tm_mday=cal_day+delta;
  time_t tt=mktime(&t);
  struct tm out;
  localtime_r(&tt,&out);
  cal_year=out.tm_year+1900;cal_month=out.tm_mon+1;cal_day=out.tm_mday;
  if(cal_year<PIKO_LUNAR_YEAR_MIN||cal_year>PIKO_LUNAR_YEAR_MAX)cal_step(-delta);  // 越界回弹
}
static void cal_enter_today(void) {
  cal_view=0;
  int y,m,d;
  cal_today(&y,&m,&d);
  if(cal_has_date){cal_year=y;cal_month=m;cal_day=d;}
}
static void cal_toggle(void) { cal_view^=1; }
static bool cal_viewing_today(void) {
  int y,m,d;
  cal_today(&y,&m,&d);
  return cal_has_date&&y==cal_year&&m==cal_month&&d==cal_day;
}
static void show_cal_today(void) {
  show_zone(UI_CAL);
  lv_obj_set_hidden(cal_today_box,false);
  lv_obj_set_hidden(cal_month_box,true);
  piko_lunar_date ld;
  if(piko_lunar_from_solar(cal_year,cal_month,cal_day,&ld)!=0){cal_has_date=false;return;}
  static const char *const wd[7]={"星期一","星期二","星期三","星期四","星期五","星期六","星期日"};
  int w=piko_lunar_weekday(cal_year,cal_month,cal_day);
  lv_label_set_text_fmt(cal_d_big,"%d",cal_day);
  lv_label_set_text_fmt(cal_d_line,"%s · 农历%s%s",wd[w],ld.month_cn,ld.day_cn);
  const char *term=piko_lunar_term_on(cal_year,cal_month,cal_day);
  char fest[16];
  piko_lunar_festival(cal_year,cal_month,cal_day,&ld,fest,sizeof(fest));
  if(term)lv_label_set_text_fmt(cal_d_jie,"%s年 · %s",ld.gz_year,term);
  else if(fest[0])lv_label_set_text_fmt(cal_d_jie,"%s年 · %s",ld.gz_year,fest);
  else lv_label_set_text_fmt(cal_d_jie,"%s年 · %s",ld.gz_year,ld.animal);
  char yi[40],ji[40],note[48],pz[48];
  piko_lunar_almanac(cal_year,cal_month,cal_day,&ld,yi,sizeof(yi),ji,sizeof(ji),note,sizeof(note),pz,sizeof(pz));
  lv_label_set_text_fmt(cal_d_yi,"宜 %s",yi);
  lv_label_set_text_fmt(cal_d_ji,"忌 %s",ji);
  lv_label_set_text(cal_d_pz,pz);
  lv_label_set_text(notice,note);
}
static void show_cal_month(void) {
  show_zone(UI_CAL);
  lv_obj_set_hidden(cal_today_box,true);
  lv_obj_set_hidden(cal_month_box,false);
  piko_lunar_date ld;
  if(piko_lunar_from_solar(cal_year,cal_month,1,&ld)==0)
    lv_label_set_text_fmt(notice,"%s年 · %s",ld.gz_year,ld.animal);
  int first=piko_lunar_weekday(cal_year,cal_month,1);
  int days=piko_lunar_solar_days(cal_year,cal_month);
  int ty,tm,td;
  cal_today(&ty,&tm,&td);
  for(int i=0;i<42;i++){
    lv_obj_t *cell=cal_m_cell[i];
    int day=i-first+1;
    if(day<1||day>days){lv_label_set_text(cell,"");continue;}
    lv_label_set_text_fmt(cell,"%d",day);
    bool mark=piko_lunar_term_on(cal_year,cal_month,day)!=NULL;
    if(!mark){
      char fest[12];
      piko_lunar_festival(cal_year,cal_month,day,NULL,fest,sizeof(fest));
      mark=fest[0]!='\0';
    }
    bool today=cal_has_date&&ty==cal_year&&tm==cal_month&&td==day;
    lv_obj_set_style_text_color(cell,lv_color_hex(mark||today?PIKO_ACCENT:PIKO_INK),0);
    if(day==cal_day){
      lv_obj_set_pos(cal_ring,(i%7)*34+5,(i/7)*24+20);
      lv_obj_set_hidden(cal_ring,false);
    }
  }
}
// —— 时钟页：段码/月相/亮度/息屏 ——
static void clk_apply_brightness(void) { bsp_display_backlight(screen_off||clk_screen_off?0:clk_bright_pct[clk_bright]); }
static bool clk_save(void) {
  nvs_handle_t h;
  if(nvs_open("piko",NVS_READWRITE,&h)!=ESP_OK)return false;
  esp_err_t r=nvs_set_u8(h,"bright5",clk_bright);
  if(r==ESP_OK)r=nvs_set_u8(h,"idlemin",clk_idle_mode);
  if(r==ESP_OK)r=nvs_commit(h);
  nvs_close(h);
  return r==ESP_OK;
}
static void clk_show_time(const model_t *m,int battery) {
  time_t nowt=time(NULL);
  struct tm tm_info;
  bool synced=nowt>1700000000;
  if(synced)localtime_r(&nowt,&tm_info);
  int sec=synced?tm_info.tm_sec:0;
  if(!synced||sec!=clk_last_sec){
    clk_last_sec=sec;
    if(synced)
      lv_label_set_text_fmt(clk_time_label,"%02d:%02d",tm_info.tm_hour,tm_info.tm_min);
    else
      lv_label_set_text(clk_time_label,"--:--");
    lv_label_set_text_fmt(clk_sec_label,synced?"%02d":"--",sec);
    // 冒号闪动：未同步常暗，同步后每秒明暗交替（残影常显）。
    lv_obj_set_style_text_opa(clk_time_label,LV_OPA_COVER,0);
  }
  static const char *const wd[7]={"SU","MO","TU","WE","TH","FR","SA"};
  for(int k=0;k<7;k++){
    bool on=synced&&tm_info.tm_wday==k;
    lv_obj_set_style_bg_opa(clk_wk[k],on?LV_OPA_COVER:LV_OPA_TRANSP,0);
    lv_obj_set_style_text_color(clk_wk[k],lv_color_hex(on?0xa9c96b:0x26331c),0);
  }
  if(synced){
    int stage=piko_clock_moon_stage(tm_info.tm_year+1900,tm_info.tm_mon+1,tm_info.tm_mday);
    if(stage==0){lv_obj_set_style_bg_opa(clk_moon_disc,LV_OPA_TRANSP,0);}
    else{
      lv_obj_set_style_bg_opa(clk_moon_disc,LV_OPA_COVER,0);
      int off=1+(stage<4?(4-stage):(stage-4))*2;
      lv_obj_set_pos(clk_moon_disc,off>5?5:off,1);
    }
    lv_label_set_text_fmt(clk_date,"%02d-%02d",tm_info.tm_mon+1,tm_info.tm_mday);
    int y=tm_info.tm_year+1900;
    static const int cum[12]={0,31,59,90,120,151,181,212,243,273,304,334};
    int doy=cum[tm_info.tm_mon]+tm_info.tm_mday;
    bool leap=(y%4==0&&y%100!=0)||y%400==0;
    if(tm_info.tm_mon>1&&leap)doy++;
    int wday_iso=tm_info.tm_wday==0?7:tm_info.tm_wday;
    char week_text[4];strftime(week_text,sizeof(week_text),"%V",&tm_info);
    int wknum=atoi(week_text);
    (void)wday_iso;
    lv_label_set_text_fmt(clk_doy,"WK%02d · D%d",wknum,doy);
    struct tm utc_time;gmtime_r(&nowt,&utc_time);
    lv_label_set_text_fmt(clk_wt,"WT UTC %02d:%02d",utc_time.tm_hour,utc_time.tm_min);
    piko_lunar_date ld;
    char strip[64];
    if(piko_lunar_from_solar(y,tm_info.tm_mon+1,tm_info.tm_mday,&ld)==0){
      const char *term=piko_lunar_term_on(y,tm_info.tm_mon+1,tm_info.tm_mday);
      char fest[16];piko_lunar_festival(y,tm_info.tm_mon+1,tm_info.tm_mday,&ld,fest,sizeof(fest));
      if(term)snprintf(strip,sizeof(strip),"%s",term);
      else if(fest[0])snprintf(strip,sizeof(strip),"%s",fest);
      else snprintf(strip,sizeof(strip),"农历%s%s",ld.month_cn,ld.day_cn);
    }else strip[0]=0;
    lv_label_set_text(clk_lunar,strip);
  }else{
    lv_label_set_text(clk_date,"--/--");
    lv_label_set_text(clk_doy,"");
    lv_label_set_text(clk_wt,"WT UTC --:--");
    lv_label_set_text(clk_lunar,"等待校时");
  }
  int level=battery<0?0:((battery+19)/20);
  if(level>5)level=5;
  for(int k=0;k<5;k++)lv_obj_set_style_bg_opa(clk_batt[k],k<level?LV_OPA_COVER:LV_OPA_20,0);
  (void)m;
}
static void clk_show_menu(void) {
  static const char *const mode_name[PIKO_CLK_IDLE_MODES]={"常亮","10 分钟","2 分钟"};
  static const char *const mode_val[PIKO_CLK_IDLE_MODES]={"常亮","10 分钟","2 分钟"};
  (void)mode_name;
  lv_label_set_text(clk_menu_val[0],mode_val[clk_idle_mode]);
  lv_label_set_text_fmt(clk_menu_val[1],"%d/4",clk_bright);
  for(int k=0;k<2;k++){
    lv_obj_set_style_border_width(clk_menu_row_obj[k],clk_menu_open&&clk_menu_row==k?2:0,0);
    lv_obj_set_style_bg_opa(clk_menu_row_obj[k],clk_menu_open?LV_OPA_90:LV_OPA_TRANSP,0);
  }
  lv_obj_set_hidden(clk_lcd,clk_menu_open);
  lv_obj_set_hidden(clk_menu_box,!clk_menu_open);
}
static void ui_navigation(void) {
  const char *names[] = {"语音", "Piko", "日历", "时钟", "设置", "翻页"};
  for (unsigned k = 0; k < PAGE_COUNT; k++) {
    lv_label_set_text(nav_dots[k], names[k]);
    lv_obj_set_style_bg_opa(nav_dots[k], k == (unsigned)page ? LV_OPA_COVER : LV_OPA_20, 0);
    lv_obj_set_style_text_color(nav_dots[k], lv_color_hex(k == (unsigned)page ? 0xffffff : PIKO_MUTED), 0);
  }
}
static void render(const model_t *m,int battery) {
  // esp_lvgl_port treats 0 as wait forever; 1ms is a bounded try-lock.
  if(!bsp_lvgl_lock(1))return;
  ui_navigation();
  lv_obj_set_style_text_color(status_wifi,
      lv_color_hex(m->wifi_ready && !m->setup ? PIKO_INK : PIKO_DISABLED), 0);
  const char *bsym = battery < 0 ? LV_SYMBOL_BATTERY_EMPTY :
      battery >= 85 ? LV_SYMBOL_BATTERY_FULL : battery >= 60 ? LV_SYMBOL_BATTERY_3 :
      battery >= 35 ? LV_SYMBOL_BATTERY_2 : battery >= 12 ? LV_SYMBOL_BATTERY_1 :
      LV_SYMBOL_BATTERY_EMPTY;
  lv_label_set_text(status_battery, bsym);
  if (battery >= 0) lv_label_set_text_fmt(status_pct, "%d%%", battery);
  else lv_label_set_text(status_pct, "--%");
  time_t nowt = time(NULL);
  if (nowt > 1700000000) {
    struct tm tm_info;
    localtime_r(&nowt, &tm_info);
    lv_label_set_text_fmt(status_clock, "%02d/%02d %02d:%02d",
        tm_info.tm_mon + 1, tm_info.tm_mday, tm_info.tm_hour, tm_info.tm_min);
  } else lv_label_set_text(status_clock, "--/-- --:--");
  if (m->setup) {
    lv_label_set_text(title, "连接你的 Piko");
    lv_label_set_text(notice, setup_reason == PIKO_WIFI_AUTH_FAILED ?
        "密码或认证失败，请重新填写" : setup_reason == PIKO_WIFI_TIMEOUT ?
        "连接超时，请检查网络" : "按提示完成配网");
    char text[160];
    snprintf(text, sizeof(text), "手机连接热点\n%s\n浏览器打开\n192.168.4.1", setup_ssid);
    show_card(text, 0);
    lv_label_set_text(hint_label, "保存后设备自动连接");
  } else if (page == PAGE_SETTINGS) {
    if(!page_locked || settings_view==VIEW_MAIN){
      lv_label_set_text(title,"设置");
      lv_label_set_text(notice,"");
      show_menu();
      lv_label_set_text_fmt(hint_label,"%s\n%s",page_locked?"上下选择 · 确认进入 · 长按返回":"短按确认进入 · 上下切页",FW_VERSION);
    }else if(settings_view==VIEW_REPRO){
      lv_label_set_text(title,"Wi-Fi 网络");
      lv_label_set_text(notice,m->wifi_ready?"网络已连接":"网络未连接");
      char text[160];snprintf(text,sizeof(text),"当前网络\n%s\n重新配网将重启设备",cfg.ssid[0]?cfg.ssid:"尚未配置");
      show_card(text,0);
      lv_label_set_text(hint_label,"长按重新配网 · 短按返回");
    }else{
      lv_label_set_text(title,"电脑配对");
      lv_label_set_text(notice,m->authenticated?"电脑已连接":atomic_load(&link_mode)==2?"正在解除配对":"正在寻找电脑");
      if(link_confirm){
        show_card("解除与当前电脑的配对？\n无线网络设置保留。",0);
        lv_label_set_text(hint_label,"长按解除配对 · 短按取消");
      }else{
        char text[160];snprintf(text,sizeof(text),"%s\n%s",cfg.token[0]?"已配对电脑":"等待电脑确认配对",cfg.host[0]?cfg.host:"请打开电脑上的 Piko");
        show_card(text,0);
        lv_label_set_text(hint_label,cfg.token[0]&&atomic_load(&link_mode)!=2?"短按解除配对 · 长按返回":"长按返回设置");
      }
    }
  } else if (page == PAGE_CALENDAR) {
    if (!page_locked) {
      lv_label_set_text(title, "日历");
      lv_label_set_text(notice, "");
      show_min(LV_SYMBOL_LIST, "日历", "农历 · 节气 · 宜忌");
      lv_label_set_text(hint_label, "上下切页");
    } else if (!cal_has_date) {
      lv_label_set_text(title, "日历");
      lv_label_set_text(notice, "");
      show_min(LV_SYMBOL_REFRESH, "时钟未同步", "联网后自动校时");
      lv_label_set_text(hint_label, "长按退出");
    } else if (cal_view == 0) {
      lv_label_set_text(title, cal_viewing_today() ? "今日黄历" : "黄历");
      show_cal_today();
      lv_label_set_text(hint_label, "上下翻日 · 确认看月历 · 长按退出");
    } else {
      lv_label_set_text_fmt(title, "%d年%d月", cal_year, cal_month);
      show_cal_month();
      lv_label_set_text(hint_label, "上下选日 · 确认看详情 · 长按退出");
    }
  } else if (page == PAGE_CLOCK) {
    if (!page_locked) {
      lv_label_set_text(title, "时钟");
      lv_label_set_text(notice, "");
      show_min(LV_SYMBOL_BELL, "时钟", "亮度 · 息屏");
      lv_label_set_text(hint_label, "上下切页");
    } else {
      show_zone(UI_CLK);
      lv_label_set_text(title, "时钟");
      clk_show_time(m,battery);
      clk_show_menu();
      bool bright_now=esp_timer_get_time()<clk_bright_until;
      lv_obj_set_hidden(clk_bbar,!bright_now||clk_menu_open);
      if(bright_now&&!clk_menu_open){
        lv_label_set_text_fmt(notice,"亮度 %d%%",clk_bright_pct[clk_bright]);
        lv_obj_set_size(clk_bfill,29*(clk_bright+1),4);
      }
      lv_label_set_text(hint_label,clk_menu_open?"上下选择 · 确认改值 · 长按返回":"上下亮度 · 确认菜单 · 长按退出");
    }
  } else if (page == PAGE_PAGER) {
    lv_label_set_text(title,"蓝牙翻页器");
    lv_label_set_text(notice,"");
    if(!page_locked){
      show_min(LV_SYMBOL_BLUETOOTH,pager_start_failed?"蓝牙启动失败":"蓝牙翻页","短按确认进入");
      lv_label_set_text(hint_label,pager_start_failed?"确认重试 · 上下切页":"上下切页");
    }else{
      show_zone(UI_PAGER);
      pager_page_decorate(title,notice,hint_label,page_locked);
    }
  } else if (page == PAGE_INPUT) {
    voice_input_status_t input = voice_input_status();
    lv_label_set_text(title, "语音输入");
    if (!page_locked) {
      show_min(LV_SYMBOL_KEYBOARD,"语音输入","短按确认进入");
      lv_label_set_text(hint_label,"上下切页");
    } else if (input.recording) {
      uint64_t elapsed = (esp_timer_get_time() - input_rec_started) / 1000000;
      char big[8];
      snprintf(big, sizeof(big), "%02u:%02u",
               (unsigned)(elapsed / 60), (unsigned)(elapsed % 60));
      show_mic(true, big, "松开上键 · 结束");
      lv_label_set_text(hint_label, "");
    } else if (input.draining) {
      show_min(LV_SYMBOL_REFRESH, "正在结束", "");
      lv_label_set_text(hint_label, "");
    } else if (input.selected) {
      show_min(LV_SYMBOL_OK, "已选择电脑", "上键说话 · 下键回车");
      lv_label_set_text(hint_label, "短按确认键 退出输入");
    } else if (input.candidate) {
      show_min(LV_SYMBOL_DRIVE, "发现电脑", "短按确认键 选择");
      lv_label_set_text(hint_label, "");
    } else {
      show_min(LV_SYMBOL_AUDIO, "等待电脑端", "启动语音客户端");
      lv_label_set_text(hint_label, "");
    }
    lv_label_set_text(notice, input.error ? "输入异常，请退出重试。" :
        (input.selected || input.candidate) && input.peer[0] ? input.peer : "");
  } else {
    lv_label_set_text(title,page_locked?"Piko · 已进入":"和 Piko 聊聊");
    lv_label_set_text(notice, "");
    if (!page_locked) {
      show_mic(false,"和 Piko 聊聊","短按确认进入");
      lv_label_set_text(hint_label,"上下切页");
    } else if (strcmp(m->voice_stage, "listening") == 0) {
      uint64_t elapsed = (esp_timer_get_time() - voice_started) / 1000000;
      char big[8];
      snprintf(big, sizeof(big), "%02u:%02u",
               (unsigned)(elapsed / 60), (unsigned)(elapsed % 60));
      show_mic(true, big, "松开确认键 · 发送");
      lv_label_set_text(hint_label, "");
    } else if (strcmp(m->voice_stage, "awaiting_confirmation") == 0) {
      show_card(m->confirmation_text,m->voice_text_at);
      if(confirmation_seen_epoch!=m->confirmation_gate.epoch){
        confirmation_seen_epoch=m->confirmation_gate.epoch;confirmation_pages_seen=0;
      }
      if(text_page_index<64)confirmation_pages_seen|=UINT64_C(1)<<text_page_index;
      bool all_read=piko_pages_complete(confirmation_pages_seen,text_page_count);
      if(all_read){
        xSemaphoreTake(mutex,portMAX_DELAY);
        piko_confirmation_show(&model.confirmation_gate,m->confirmation_gate.epoch);
        xSemaphoreGive(mutex);
      }
      lv_label_set_text(hint_label,m->confirmation_gate.desktop_only?"请在电脑确认 · 短按退出":
          all_read?"长按确认执行 · 短按退出":"上下阅读 · 短按退出");
    } else if (piko_voice_readable_text(m->voice_busy,m->voice_stage,m->transcript,m->reply)) {
      lv_label_set_text(title,m->reply[0]?"Piko 回复":"你说的话");
      lv_label_set_text(notice,voice_stage_label(m->voice_stage));
      show_card(piko_voice_readable_text(m->voice_busy,m->voice_stage,m->transcript,m->reply),
          m->voice_text_at);
      lv_label_set_text(hint_label,text_page_count>1?
          "上下翻页 · 确认退出":"短按确认退出");
    } else if (m->voice_busy) {
      show_min(LV_SYMBOL_REFRESH, voice_stage_label(m->voice_stage), "");
      lv_label_set_text(hint_label, "短按确认退出");
    } else {
      const char *text = strcmp(m->voice_stage, "error") == 0 ||
          (strcmp(m->voice_stage, "cancelled") == 0 && m->voice_note[0]) ?
          m->voice_note[0] ? m->voice_note : "语音未完成，请重试。" :
          m->reply[0] ? m->reply : m->voice_note[0] ? m->voice_note :
          m->transcript[0] ? m->transcript : NULL;
      if (!m->authenticated) {
        show_min(LV_SYMBOL_WIFI, "未连接", "请在设置页连接电脑");
        lv_label_set_text(hint_label, "");
      } else if (text) {
        show_card(text, m->voice_text_at);
        lv_label_set_text(hint_label, text_page_count > 1 ?
            "上下翻页 · 按住确认说话" : "按住确认说话 · 短按退出");
      } else {
        show_mic(false, "按住确认说话", "短按退出 · 长按上下调音量");
        lv_label_set_text(hint_label, "");
      }
    }
  }
  bool volume_visible=page==PAGE_PIKO && page_locked && esp_timer_get_time()<volume_notice_until;
  lv_obj_set_hidden(volume_bar,!volume_visible);
  if(volume_visible)lv_bar_set_value(volume_bar,volume_level,LV_ANIM_OFF);
  if(page==PAGE_PIKO && page_locked){
    if(!m->voice_busy && esp_timer_get_time()-chat_session_started<1800000)
      lv_label_set_text(notice,"新聊天已开始");
    if(esp_timer_get_time()<volume_notice_until)
      lv_label_set_text_fmt(notice,volume_level?"播报音量 %u%%":"播报已静音",volume_percent[volume_level]);
    if(esp_timer_get_time()<settings_error_until)lv_label_set_text(notice,"保存失败，请重试。");
  }
  if(!page_locked && audio_start_failed && (page==PAGE_INPUT||page==PAGE_PIKO)){
    lv_label_set_text(notice,"音频启动失败");lv_label_set_text(hint_label,"短按确认重试");
  }
  bsp_lvgl_unlock();
}

static lv_obj_t *ui_zone(lv_obj_t *parent) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_size(o, 240, 168);
  lv_obj_set_pos(o, 0, 78);
  lv_obj_set_style_pad_all(o, 0, 0);
  lv_obj_set_style_border_width(o, 0, 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_TRANSP, 0);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
  return o;
}
static lv_obj_t *ui_circle(lv_obj_t *parent, lv_coord_t x, lv_coord_t y, lv_coord_t size) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_size(o, size, size);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_style_radius(o, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_border_width(o, 0, 0);
  lv_obj_set_style_pad_all(o, 0, 0);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
  return o;
}
static lv_obj_t *ui_piece(lv_obj_t *parent, lv_coord_t w, lv_coord_t h,
                          lv_coord_t x, lv_coord_t y, lv_coord_t radius) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_size(o, w, h);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_style_radius(o, radius, 0);
  lv_obj_set_style_border_width(o, 0, 0);
  lv_obj_set_style_bg_color(o, lv_color_hex(PIKO_ACCENT), 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
  return o;
}
static lv_obj_t *ui_zone_label(lv_obj_t *zone, lv_coord_t y, const lv_font_t *font,
                               lv_color_t color) {
  lv_obj_t *o = lv_label_create(zone);
  lv_obj_set_width(o, 240);
  lv_obj_set_style_text_font(o, font, 0);
  lv_obj_set_style_text_color(o, color, 0);
  lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(o, LV_ALIGN_TOP_MID, 0, y);
  return o;
}

static void create_zone_mic(void) {
  lv_obj_t *screen=lv_screen_active();
  zone_mic=ui_zone(screen);
  for(unsigned k=0;k<2;k++){
    mic_ring[k]=lv_obj_create(zone_mic);lv_obj_set_size(mic_ring[k],56,56);lv_obj_set_pos(mic_ring[k],92,0);
    lv_obj_set_style_radius(mic_ring[k],LV_RADIUS_CIRCLE,0);
    lv_obj_set_style_border_width(mic_ring[k],2,0);lv_obj_set_style_border_color(mic_ring[k],lv_color_hex(PIKO_ACCENT),0);
    lv_obj_set_style_bg_opa(mic_ring[k],LV_OPA_TRANSP,0);lv_obj_set_style_opa(mic_ring[k],0,0);
    lv_obj_remove_flag(mic_ring[k],LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(mic_ring[k],LV_OBJ_FLAG_CLICKABLE);
  }
  mic_box=ui_circle(zone_mic,92,0,56);
  lv_obj_set_style_bg_color(mic_box,lv_color_hex(PIKO_ACCENT),0);lv_obj_set_style_bg_opa(mic_box,LV_OPA_10,0);
  mic_cap=ui_piece(mic_box,14,20,21,6,7);
  mic_arc=lv_arc_create(mic_box);lv_obj_set_size(mic_arc,28,28);lv_obj_set_pos(mic_arc,14,18);
  lv_arc_set_bg_angles(mic_arc,315,225);lv_arc_set_range(mic_arc,0,360);lv_arc_set_value(mic_arc,0);
  lv_obj_set_style_arc_width(mic_arc,2,LV_PART_MAIN);lv_obj_set_style_arc_color(mic_arc,lv_color_hex(PIKO_ACCENT),LV_PART_MAIN);
  lv_obj_set_style_arc_rounded(mic_arc,false,LV_PART_MAIN);lv_obj_set_style_bg_opa(mic_arc,LV_OPA_TRANSP,0);
  lv_obj_remove_style(mic_arc,NULL,LV_PART_KNOB);lv_obj_remove_flag(mic_arc,LV_OBJ_FLAG_CLICKABLE);
  mic_stem=ui_piece(mic_box,2,6,27,42,1);
  mic_base=ui_piece(mic_box,14,2,21,50,1);
  mic_big=ui_zone_label(zone_mic,64,&title_font,lv_color_hex(PIKO_INK));
  mic_sub=ui_zone_label(zone_mic,94,&piko_ui_small,lv_color_hex(PIKO_MUTED));

}

static void create_zone_min(void) {
  lv_obj_t *screen=lv_screen_active();
  zone_min=ui_zone(screen);
  lv_obj_t *min_box=ui_circle(zone_min,92,0,56);
  lv_obj_set_style_bg_color(min_box,lv_color_hex(PIKO_ACCENT),0);lv_obj_set_style_bg_opa(min_box,LV_OPA_10,0);
  min_icon=lv_label_create(min_box);lv_obj_set_style_text_font(min_icon,&lv_font_montserrat_20,0);lv_obj_set_style_text_color(min_icon,lv_color_hex(PIKO_ACCENT),0);lv_obj_align(min_icon,LV_ALIGN_CENTER,0,0);
  min_big=ui_zone_label(zone_min,64,&title_font,lv_color_hex(PIKO_INK));
  min_sub=ui_zone_label(zone_min,94,&piko_ui_small,lv_color_hex(PIKO_MUTED));

}

static void create_zone_card(void) {
  lv_obj_t *screen=lv_screen_active();
  zone_card=ui_zone(screen);
  card_panel=lv_obj_create(zone_card);lv_obj_set_size(card_panel,196,120);lv_obj_set_pos(card_panel,22,24);
  lv_obj_set_style_bg_color(card_panel,lv_color_hex(PIKO_CARD),0);lv_obj_set_style_bg_opa(card_panel,LV_OPA_70,0);
  lv_obj_set_style_border_color(card_panel,lv_color_hex(PIKO_CARD_BORDER),0);lv_obj_set_style_border_width(card_panel,1,0);
  lv_obj_set_style_radius(card_panel,16,0);lv_obj_set_style_pad_all(card_panel,0,0);
  lv_obj_set_style_shadow_width(card_panel,14,0);lv_obj_set_style_shadow_color(card_panel,lv_color_hex(PIKO_ACCENT),0);lv_obj_set_style_shadow_opa(card_panel,LV_OPA_20,0);
  lv_obj_remove_flag(card_panel,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(card_panel,LV_OBJ_FLAG_CLICKABLE);
  card_text=lv_label_create(card_panel);lv_label_set_long_mode(card_text,LV_LABEL_LONG_CLIP);lv_obj_set_width(card_text,168);lv_obj_set_pos(card_text,14,10);
  lv_obj_set_style_text_line_space(card_text,2,0);lv_obj_set_style_text_align(card_text,LV_TEXT_ALIGN_LEFT,0);
  card_page=lv_label_create(card_panel);
  lv_obj_set_width(card_page,168);lv_obj_set_pos(card_page,14,99);
  lv_obj_set_style_text_font(card_page,&lv_font_montserrat_14,0);
  lv_obj_set_style_text_color(card_page,lv_color_hex(PIKO_MUTED),0);
  lv_obj_set_style_text_align(card_page,LV_TEXT_ALIGN_CENTER,0);
}

static void create_zone_menu(void) {
  lv_obj_t *screen=lv_screen_active();
  zone_menu=ui_zone(screen);
  for(unsigned k=0;k<2;k++){
    menu_row[k]=lv_obj_create(zone_menu);lv_obj_set_size(menu_row[k],200,28);lv_obj_set_pos(menu_row[k],20,12+30*k);
    lv_obj_set_style_radius(menu_row[k],10,0);lv_obj_set_style_border_width(menu_row[k],0,0);lv_obj_set_style_pad_all(menu_row[k],0,0);
    lv_obj_set_style_bg_color(menu_row[k],lv_color_hex(PIKO_ACCENT),0);lv_obj_set_style_bg_opa(menu_row[k],LV_OPA_TRANSP,0);
    lv_obj_remove_flag(menu_row[k],LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(menu_row[k],LV_OBJ_FLAG_CLICKABLE);
    menu_icon[k]=lv_label_create(menu_row[k]);lv_obj_set_style_text_font(menu_icon[k],&lv_font_montserrat_14,0);lv_obj_set_style_text_color(menu_icon[k],lv_color_hex(PIKO_ACCENT),0);lv_obj_align(menu_icon[k],LV_ALIGN_LEFT_MID,10,0);
    menu_name[k]=lv_label_create(menu_row[k]);lv_obj_set_style_text_font(menu_name[k],&piko_ui_small,0);lv_obj_align(menu_name[k],LV_ALIGN_LEFT_MID,32,0);
    menu_value[k]=lv_label_create(menu_row[k]);lv_obj_set_style_text_font(menu_value[k],&piko_ui_small,0);lv_obj_set_style_text_color(menu_value[k],lv_color_hex(PIKO_MUTED),0);lv_obj_align(menu_value[k],LV_ALIGN_RIGHT_MID,-10,0);
  }

}

static void create_zone_cal(void) {
  lv_obj_t *screen=lv_screen_active();
  zone_cal=ui_zone(screen);
  cal_today_box=lv_obj_create(zone_cal);lv_obj_set_size(cal_today_box,240,168);lv_obj_set_pos(cal_today_box,0,0);
  lv_obj_set_style_pad_all(cal_today_box,0,0);lv_obj_set_style_border_width(cal_today_box,0,0);lv_obj_set_style_bg_opa(cal_today_box,LV_OPA_TRANSP,0);
  lv_obj_remove_flag(cal_today_box,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(cal_today_box,LV_OBJ_FLAG_CLICKABLE);
  cal_d_big=ui_zone_label(cal_today_box,0,&lv_font_montserrat_36,lv_color_hex(PIKO_INK));
  cal_d_line=ui_zone_label(cal_today_box,42,&piko_chinese,lv_color_hex(PIKO_INK));
  cal_d_jie=ui_zone_label(cal_today_box,64,&piko_ui_small,lv_color_hex(PIKO_ACCENT));
  static const struct { lv_obj_t **lab; lv_coord_t y; } cal_cards[] = {
      {&cal_d_yi, 84}, {&cal_d_ji, 114},
  };
  for(unsigned k=0;k<2;k++){
    lv_obj_t *card=lv_obj_create(cal_today_box);lv_obj_set_size(card,200,26);lv_obj_set_pos(card,20,cal_cards[k].y);
    lv_obj_set_style_radius(card,10,0);
    lv_obj_set_style_bg_color(card,lv_color_hex(PIKO_CARD),0);lv_obj_set_style_bg_opa(card,LV_OPA_70,0);
    lv_obj_set_style_border_color(card,lv_color_hex(PIKO_CARD_BORDER),0);lv_obj_set_style_border_width(card,1,0);
    lv_obj_set_style_pad_all(card,0,0);
    lv_obj_remove_flag(card,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(card,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_t *lab=lv_label_create(card);lv_obj_set_style_text_font(lab,&piko_ui_small,0);
    lv_obj_align(lab,LV_ALIGN_LEFT_MID,10,0);
    *cal_cards[k].lab=lab;
  }
  cal_d_pz=ui_zone_label(cal_today_box,144,&piko_ui_small,lv_color_hex(PIKO_MUTED));
  cal_month_box=lv_obj_create(zone_cal);lv_obj_set_size(cal_month_box,240,168);lv_obj_set_pos(cal_month_box,0,0);
  lv_obj_set_style_pad_all(cal_month_box,0,0);lv_obj_set_style_border_width(cal_month_box,0,0);lv_obj_set_style_bg_opa(cal_month_box,LV_OPA_TRANSP,0);
  lv_obj_remove_flag(cal_month_box,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(cal_month_box,LV_OBJ_FLAG_CLICKABLE);
  {
    static const char *const wk[7]={"一","二","三","四","五","六","日"};
    for(int c=0;c<7;c++){
      lv_obj_t *lab=lv_label_create(cal_month_box);
      lv_label_set_text(lab,wk[c]);
      lv_obj_set_style_text_font(lab,&piko_ui_small,0);lv_obj_set_style_text_color(lab,lv_color_hex(PIKO_MUTED),0);
      lv_obj_set_width(lab,34);lv_obj_set_style_text_align(lab,LV_TEXT_ALIGN_CENTER,0);
      lv_obj_set_pos(lab,c*34,2);
    }
  }
  for(int i=0;i<42;i++){
    lv_obj_t *cell=lv_label_create(cal_month_box);
    lv_obj_set_width(cell,34);lv_obj_set_style_text_align(cell,LV_TEXT_ALIGN_CENTER,0);
    lv_obj_set_style_text_font(cell,&piko_chinese,0);
    lv_obj_set_pos(cell,(i%7)*34,(i/7)*24+20);
    cal_m_cell[i]=cell;
  }
  cal_ring=lv_obj_create(cal_month_box);
  lv_obj_set_size(cal_ring,30,22);
  lv_obj_set_style_radius(cal_ring,LV_RADIUS_CIRCLE,0);
  lv_obj_set_style_border_width(cal_ring,2,0);
  lv_obj_set_style_border_color(cal_ring,lv_color_hex(PIKO_ACCENT),0);
  lv_obj_set_style_bg_opa(cal_ring,LV_OPA_TRANSP,0);
  lv_obj_remove_flag(cal_ring,LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_remove_flag(cal_ring,LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_hidden(cal_ring,true);
}

static void create_zone_clk(void) {
  clk_last_sec=99;
  lv_obj_t *screen=lv_screen_active();
  zone_clk=ui_zone(screen);
  clk_lcd=lv_obj_create(zone_clk);lv_obj_set_size(clk_lcd,216,152);lv_obj_set_pos(clk_lcd,12,8);
  lv_obj_set_style_radius(clk_lcd,12,0);
  lv_obj_set_style_bg_color(clk_lcd,lv_color_hex(0xa9c96b),0);lv_obj_set_style_bg_opa(clk_lcd,LV_OPA_COVER,0);
  lv_obj_set_style_border_color(clk_lcd,lv_color_hex(0x2a2a28),0);lv_obj_set_style_border_width(clk_lcd,3,0);
  lv_obj_set_style_pad_all(clk_lcd,0,0);
  lv_obj_remove_flag(clk_lcd,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_lcd,LV_OBJ_FLAG_CLICKABLE);
  {
    lv_obj_t *brand=lv_label_create(clk_lcd);lv_label_set_text(brand,"PIKO");
    lv_obj_set_style_text_font(brand,&piko_ui_small,0);lv_obj_set_style_text_color(brand,lv_color_hex(0x26331c),0);
    lv_obj_align(brand,LV_ALIGN_TOP_LEFT,8,3);
    clk_brand_sub=lv_label_create(clk_lcd);lv_label_set_text(clk_brand_sub,"ILLUMINATOR · 24H");
    lv_obj_set_style_text_font(clk_brand_sub,&piko_ui_small,0);lv_obj_set_style_text_color(clk_brand_sub,lv_color_hex(0x26331c),0);
    lv_obj_set_style_text_opa(clk_brand_sub,LV_OPA_70,0);lv_obj_align(clk_brand_sub,LV_ALIGN_TOP_RIGHT,-8,5);
  }
  {
    static const char *const wk[7]={"SU","MO","TU","WE","TH","FR","SA"};
    for(int k=0;k<7;k++){
      clk_wk[k]=lv_label_create(clk_lcd);lv_label_set_text(clk_wk[k],wk[k]);
      lv_obj_set_style_text_font(clk_wk[k],&piko_ui_small,0);
      lv_obj_set_style_text_color(clk_wk[k],lv_color_hex(0x26331c),0);
      lv_obj_set_style_pad_left(clk_wk[k],2,0);lv_obj_set_style_pad_right(clk_wk[k],2,0);
      lv_obj_set_style_bg_color(clk_wk[k],lv_color_hex(0x26331c),0);
      lv_obj_set_style_bg_opa(clk_wk[k],LV_OPA_TRANSP,0);
      lv_obj_set_pos(clk_wk[k],8+k*20,26);
    }
    clk_moon=lv_obj_create(clk_lcd);lv_obj_set_size(clk_moon,14,14);
    lv_obj_set_style_radius(clk_moon,LV_RADIUS_CIRCLE,0);
    lv_obj_set_style_bg_color(clk_moon,lv_color_hex(0x26331c),0);lv_obj_set_style_bg_opa(clk_moon,LV_OPA_COVER,0);
    lv_obj_set_style_border_width(clk_moon,0,0);lv_obj_set_style_pad_all(clk_moon,0,0);
    lv_obj_remove_flag(clk_moon,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_moon,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(clk_moon,196,27);
    clk_moon_disc=lv_obj_create(clk_moon);lv_obj_set_size(clk_moon_disc,12,12);
    lv_obj_set_style_radius(clk_moon_disc,LV_RADIUS_CIRCLE,0);
    lv_obj_set_style_bg_color(clk_moon_disc,lv_color_hex(0xa9c96b),0);lv_obj_set_style_bg_opa(clk_moon_disc,LV_OPA_COVER,0);
    lv_obj_set_style_border_width(clk_moon_disc,0,0);lv_obj_set_style_pad_all(clk_moon_disc,0,0);
    lv_obj_remove_flag(clk_moon_disc,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_moon_disc,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(clk_moon_disc,1,1);
  }
  // 段码时间：DSEG7 字体。底层暗色 88:88 提供未点亮段残影。
  clk_ghost=lv_label_create(clk_lcd);
  lv_label_set_text(clk_ghost,"88:88");
  lv_obj_set_style_text_font(clk_ghost,&piko_seg7,0);
  lv_obj_set_style_text_color(clk_ghost,lv_color_hex(0x26331c),0);
  lv_obj_set_style_text_opa(clk_ghost,LV_OPA_10,0);
  lv_obj_set_pos(clk_ghost,12,40);
  clk_time_label=lv_label_create(clk_lcd);
  lv_label_set_text(clk_time_label,"--:--");
  lv_obj_set_style_text_font(clk_time_label,&piko_seg7,0);
  lv_obj_set_style_text_color(clk_time_label,lv_color_hex(0x26331c),0);
  lv_obj_set_pos(clk_time_label,12,40);
  clk_sec_label=lv_label_create(clk_lcd);
  lv_label_set_text(clk_sec_label,"--");
  lv_obj_set_style_text_font(clk_sec_label,&piko_seg7_small,0);
  lv_obj_set_style_text_color(clk_sec_label,lv_color_hex(0x26331c),0);
  lv_obj_set_style_text_opa(clk_sec_label,LV_OPA_80,0);
  lv_obj_set_pos(clk_sec_label,168,66);
  clk_wt=lv_label_create(clk_lcd);lv_label_set_text(clk_wt,"WT UTC --:--");
  lv_obj_set_style_text_font(clk_wt,&piko_ui_small,0);lv_obj_set_style_text_color(clk_wt,lv_color_hex(0x26331c),0);
  lv_obj_align(clk_wt,LV_ALIGN_TOP_LEFT,8,88);
  clk_lunar=lv_label_create(clk_lcd);lv_label_set_text(clk_lunar,"");
  lv_obj_set_style_text_font(clk_lunar,&piko_ui_small,0);lv_obj_set_style_text_color(clk_lunar,lv_color_hex(0x26331c),0);
  lv_obj_align(clk_lunar,LV_ALIGN_TOP_LEFT,8,106);
  for(int k=0;k<5;k++){
    clk_batt[k]=lv_obj_create(clk_lcd);lv_obj_set_size(clk_batt[k],7,10);
    lv_obj_set_style_radius(clk_batt[k],1,0);
    lv_obj_set_style_bg_color(clk_batt[k],lv_color_hex(0x26331c),0);lv_obj_set_style_bg_opa(clk_batt[k],LV_OPA_20,0);
    lv_obj_set_style_border_width(clk_batt[k],0,0);lv_obj_set_style_pad_all(clk_batt[k],0,0);
    lv_obj_remove_flag(clk_batt[k],LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_batt[k],LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(clk_batt[k],164+k*9,96);
  }
  clk_date=lv_label_create(clk_lcd);lv_label_set_text(clk_date,"--/--");
  lv_obj_set_style_text_font(clk_date,&piko_ui_small,0);lv_obj_set_style_text_color(clk_date,lv_color_hex(0x26331c),0);
  lv_obj_align(clk_date,LV_ALIGN_BOTTOM_LEFT,8,-4);
  clk_doy=lv_label_create(clk_lcd);lv_label_set_text(clk_doy,"");
  lv_obj_set_style_text_font(clk_doy,&piko_ui_small,0);lv_obj_set_style_text_color(clk_doy,lv_color_hex(0x26331c),0);
  lv_obj_set_style_text_opa(clk_doy,LV_OPA_60,0);lv_obj_align(clk_doy,LV_ALIGN_BOTTOM_MID,0,-4);
  clk_temp=lv_label_create(clk_lcd);lv_label_set_text(clk_temp,"--°C");
  lv_obj_set_style_text_font(clk_temp,&piko_ui_small,0);lv_obj_set_style_text_color(clk_temp,lv_color_hex(0x26331c),0);
  lv_obj_set_style_border_color(clk_temp,lv_color_hex(0x26331c),0);lv_obj_set_style_border_width(clk_temp,2,0);
  lv_obj_set_style_pad_left(clk_temp,3,0);lv_obj_set_style_pad_right(clk_temp,3,0);
  lv_obj_align(clk_temp,LV_ALIGN_BOTTOM_RIGHT,-8,-4);
  clk_menu_box=lv_obj_create(zone_clk);lv_obj_set_size(clk_menu_box,200,68);lv_obj_set_pos(clk_menu_box,20,96);
  lv_obj_set_style_bg_opa(clk_menu_box,LV_OPA_TRANSP,0);lv_obj_set_style_border_width(clk_menu_box,0,0);lv_obj_set_style_pad_all(clk_menu_box,0,0);
  lv_obj_remove_flag(clk_menu_box,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_menu_box,LV_OBJ_FLAG_CLICKABLE);
  {
    static const char *const names[2]={"息屏方式","背光亮度"};
    for(int k=0;k<2;k++){
      clk_menu_row_obj[k]=lv_obj_create(clk_menu_box);lv_obj_set_size(clk_menu_row_obj[k],200,30);lv_obj_set_pos(clk_menu_row_obj[k],0,k*38);
      lv_obj_set_style_radius(clk_menu_row_obj[k],10,0);
      lv_obj_set_style_bg_color(clk_menu_row_obj[k],lv_color_hex(PIKO_CARD),0);lv_obj_set_style_bg_opa(clk_menu_row_obj[k],LV_OPA_90,0);
      lv_obj_set_style_border_width(clk_menu_row_obj[k],2,0);lv_obj_set_style_border_color(clk_menu_row_obj[k],lv_color_hex(PIKO_ACCENT),0);
      lv_obj_set_style_pad_all(clk_menu_row_obj[k],0,0);
      lv_obj_remove_flag(clk_menu_row_obj[k],LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_menu_row_obj[k],LV_OBJ_FLAG_CLICKABLE);
      lv_obj_t *name=lv_label_create(clk_menu_row_obj[k]);lv_label_set_text(name,names[k]);
      lv_obj_set_style_text_font(name,&piko_ui_small,0);lv_obj_set_style_text_color(name,lv_color_hex(PIKO_INK),0);
      lv_obj_align(name,LV_ALIGN_LEFT_MID,10,0);
      clk_menu_val[k]=lv_label_create(clk_menu_row_obj[k]);
      lv_obj_set_style_text_font(clk_menu_val[k],&piko_ui_small,0);lv_obj_set_style_text_color(clk_menu_val[k],lv_color_hex(PIKO_MUTED),0);
      lv_obj_align(clk_menu_val[k],LV_ALIGN_RIGHT_MID,-10,0);
    }
  }
  clk_bbar=lv_obj_create(zone_clk);lv_obj_set_size(clk_bbar,144,4);lv_obj_set_pos(clk_bbar,48,64);
  lv_obj_set_style_radius(clk_bbar,2,0);lv_obj_set_style_bg_color(clk_bbar,lv_color_hex(PIKO_CARD_BORDER),0);
  lv_obj_set_style_border_width(clk_bbar,0,0);lv_obj_set_style_pad_all(clk_bbar,0,0);
  lv_obj_remove_flag(clk_bbar,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_bbar,LV_OBJ_FLAG_CLICKABLE);
  clk_bfill=lv_obj_create(clk_bbar);lv_obj_set_size(clk_bfill,108,4);lv_obj_set_pos(clk_bfill,0,0);
  lv_obj_set_style_bg_color(clk_bfill,lv_color_hex(PIKO_ACCENT),0);lv_obj_set_style_bg_opa(clk_bfill,LV_OPA_COVER,0);
  lv_obj_set_style_border_width(clk_bfill,0,0);lv_obj_set_style_pad_all(clk_bfill,0,0);
  lv_obj_remove_flag(clk_bfill,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(clk_bfill,LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_hidden(clk_bbar,true);
  lv_obj_set_hidden(zone_clk,true);

}

static lv_obj_t **zone_slot(unsigned kind) {
  static lv_obj_t **const slots[]={&zone_mic,&zone_min,&zone_card,&zone_menu,&zone_cal,&zone_clk};
  return kind<UI_PAGER?slots[kind]:NULL;
}
static void show_zone(unsigned kind) {
  static unsigned active=UI_NONE;
  if(active==kind)return;
  mic_anim_pause();
  if(kind!=UI_PAGER){
    lv_obj_set_size(hint_label,240,LV_SIZE_CONTENT);
    lv_label_set_long_mode(hint_label,LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_line_space(hint_label,0,0);
    lv_obj_align(hint_label,LV_ALIGN_BOTTOM_MID,0,-48);
    lv_obj_set_style_bg_color(lv_screen_active(),lv_color_hex(PIKO_BG),0);
    lv_obj_set_style_text_color(title,lv_color_hex(PIKO_INK),0);
    lv_obj_set_style_text_color(notice,lv_color_hex(PIKO_MUTED),0);
    lv_obj_set_style_text_color(hint_label,lv_color_hex(PIKO_MUTED),0);
  }
  if(active==UI_PAGER) pager_page_destroy();
  else if(active!=UI_NONE){lv_obj_t **slot=zone_slot(active);lv_obj_delete(*slot);*slot=NULL;}
  switch(kind){
    case UI_MIC:create_zone_mic();break;
    case UI_MIN:create_zone_min();break;
    case UI_CARD:create_zone_card();break;
    case UI_MENU:create_zone_menu();break;
    case UI_CAL:create_zone_cal();break;
    case UI_CLK:create_zone_clk();break;
    case UI_PAGER:pager_page_build(lv_screen_active());break;
  }
  if(kind!=UI_PAGER)lv_obj_set_hidden(*zone_slot(kind),false);
  // Page content is created after chrome; keep shared hints above it.
  lv_obj_move_to_index(hint_label,-1);lv_obj_move_to_index(nav_bar,-1);
  active=kind;
  ESP_LOGI("piko", "UI view=%u heap=%u minimum=%u",kind,
    (unsigned)esp_get_free_heap_size(),(unsigned)esp_get_minimum_free_heap_size());
}

static void create_ui(void) {
  if(!bsp_lvgl_lock(1000))abort();
  lv_obj_t *screen=lv_screen_active();
  lv_obj_set_style_bg_color(screen,lv_color_hex(PIKO_BG),0);
  lv_obj_set_style_text_color(screen,lv_color_hex(PIKO_INK),0);
  lv_obj_set_style_text_font(screen,&piko_chinese,0);
  lv_obj_set_style_pad_all(screen,0,0);lv_obj_remove_flag(screen,LV_OBJ_FLAG_SCROLLABLE);
  status_wifi=lv_label_create(screen);lv_label_set_text(status_wifi,LV_SYMBOL_WIFI);lv_obj_set_style_text_font(status_wifi,&lv_font_montserrat_14,0);lv_obj_align(status_wifi,LV_ALIGN_TOP_LEFT,10,4);
  status_battery=lv_label_create(screen);lv_obj_set_style_text_font(status_battery,&lv_font_montserrat_14,0);lv_obj_align(status_battery,LV_ALIGN_TOP_LEFT,34,4);
  status_pct=lv_label_create(screen);lv_obj_set_style_text_font(status_pct,&piko_ui_small,0);lv_obj_align(status_pct,LV_ALIGN_TOP_LEFT,56,5);
  status_clock=lv_label_create(screen);lv_obj_set_width(status_clock,110);lv_obj_set_style_text_font(status_clock,&piko_ui_small,0);lv_obj_set_style_text_color(status_clock,lv_color_hex(PIKO_MUTED),0);lv_obj_set_style_text_align(status_clock,LV_TEXT_ALIGN_RIGHT,0);lv_obj_align(status_clock,LV_ALIGN_TOP_RIGHT,-10,5);
  title_font=piko_ui_title;title_font.fallback=&piko_chinese;
  title=lv_label_create(screen);lv_obj_set_width(title,220);lv_obj_set_style_text_font(title,&title_font,0);lv_obj_set_style_text_align(title,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(title,LV_ALIGN_TOP_MID,0,26);
  notice=lv_label_create(screen);lv_obj_set_width(notice,220);lv_obj_set_style_text_font(notice,&piko_ui_small,0);lv_obj_set_style_text_color(notice,lv_color_hex(PIKO_MUTED),0);lv_obj_set_style_text_align(notice,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(notice,LV_ALIGN_TOP_MID,0,56);

  hint_label=lv_label_create(screen);lv_obj_set_width(hint_label,240);lv_obj_set_style_text_font(hint_label,&piko_ui_small,0);lv_obj_set_style_text_color(hint_label,lv_color_hex(PIKO_MUTED),0);lv_obj_set_style_text_align(hint_label,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(hint_label,LV_ALIGN_BOTTOM_MID,0,-48);

  nav_bar=lv_obj_create(screen);lv_obj_set_size(nav_bar,240,22);lv_obj_align(nav_bar,LV_ALIGN_BOTTOM_MID,0,-9);
  lv_obj_set_style_pad_all(nav_bar,0,0);lv_obj_set_style_border_width(nav_bar,0,0);lv_obj_set_style_bg_opa(nav_bar,LV_OPA_TRANSP,0);
  lv_obj_set_flex_flow(nav_bar,LV_FLEX_FLOW_ROW);lv_obj_set_flex_align(nav_bar,LV_FLEX_ALIGN_CENTER,LV_FLEX_ALIGN_CENTER,LV_FLEX_ALIGN_CENTER);
  lv_obj_remove_flag(nav_bar,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(nav_bar,LV_OBJ_FLAG_CLICKABLE);
  const char *names[]={"语音","Piko","日历","时钟","设置","翻页"};
  for(unsigned k=0;k<PAGE_COUNT;k++){
    nav_dots[k]=lv_label_create(nav_bar);
    lv_label_set_text(nav_dots[k],names[k]);
    lv_obj_set_height(nav_dots[k],22);
    lv_obj_set_style_pad_left(nav_dots[k],9,0);lv_obj_set_style_pad_right(nav_dots[k],9,0);lv_obj_set_style_pad_top(nav_dots[k],2,0);
    lv_obj_set_style_text_font(nav_dots[k],&piko_ui_small,0);lv_obj_set_style_text_align(nav_dots[k],LV_TEXT_ALIGN_CENTER,0);
    lv_obj_set_style_radius(nav_dots[k],10,0);lv_obj_set_style_bg_color(nav_dots[k],lv_color_hex(PIKO_ACCENT),0);
    lv_obj_set_style_bg_opa(nav_dots[k],LV_OPA_20,0);
    lv_obj_set_style_text_color(nav_dots[k],lv_color_hex(PIKO_MUTED),0);
  }
  volume_bar=lv_bar_create(screen);lv_obj_set_pos(volume_bar,48,72);lv_obj_set_size(volume_bar,144,4);
  lv_bar_set_range(volume_bar,0,4);lv_bar_set_value(volume_bar,volume_level,LV_ANIM_OFF);
  lv_obj_set_style_bg_color(volume_bar,lv_color_hex(PIKO_CARD_BORDER),0);
  lv_obj_set_style_bg_color(volume_bar,lv_color_hex(PIKO_ACCENT),LV_PART_INDICATOR);
  lv_obj_set_hidden(volume_bar,true);
  {
#if LV_USE_STDLIB_MALLOC == LV_STDLIB_BUILTIN
    lv_mem_monitor_t mon; lv_mem_monitor(&mon);
    ESP_LOGI("piko","LVGL pool used %u%%, free %u, peak %u", (unsigned)mon.used_pct, (unsigned)mon.free_size, (unsigned)mon.max_used);
#else
    ESP_LOGI("piko", "LVGL uses shared system heap");
#endif
    ESP_LOGI("piko", "System heap free %u, minimum %u",
             (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size()); }
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
static void settings_key(int action,bsp_btn_ev_t event) {
  if(settings_view==VIEW_MAIN){
    if(action==PIKO_MENU_PREV || action==PIKO_MENU_NEXT)menu_selected=piko_menu_step(menu_selected,action==PIKO_MENU_PREV);
    else if(action==PIKO_MENU_SELECT){settings_view=menu_selected?VIEW_LINK:VIEW_REPRO;link_confirm=link_confirm_fresh=false;}
    else if(action==PIKO_MENU_BACK)page_locked=false;
  }else if(settings_view==VIEW_REPRO){
    if(action==PIKO_MENU_BACK)setup_on_next_boot();
    else if(action==PIKO_MENU_SELECT || action==PIKO_MENU_PREV || action==PIKO_MENU_NEXT)settings_view=VIEW_MAIN;
  }else if(link_confirm){
    if(event==BSP_BTN_PRESS)link_confirm_fresh=true;
    if(action==PIKO_MENU_BACK && link_confirm_fresh)change_link(2);
    else if(action==PIKO_MENU_SELECT || action==PIKO_MENU_PREV || action==PIKO_MENU_NEXT)link_confirm=link_confirm_fresh=false;
  }else{
    if(action==PIKO_MENU_BACK)settings_view=VIEW_MAIN;
    else if(action==PIKO_MENU_SELECT && cfg.token[0] && atomic_load(&link_mode)!=2){link_confirm=true;link_confirm_fresh=false;}
  }
}
static void handle_key(key_event_t key,bool wifi_ready) {
  if(page==PAGE_CLOCK && page_locked){
    clk_activity_at=esp_timer_get_time();
    if(key.event==BSP_BTN_PRESS)clk_wake_suppress=false;
    if(clk_screen_off && !screen_off){
      clk_screen_off=0;clk_wake_suppress=true;clk_apply_brightness();return;
    }
    // Consume the whole wake gesture, including its delayed CLICK/LONG/DOUBLE.
    if(clk_wake_suppress)return;
  }

    /* BSP single/double click callbacks are mutually exclusive. Consume the
     * double before mapping events, otherwise it would become a page click. */
    if(key.event==BSP_BTN_DOUBLE){
        if(key.key==BSP_BTN_OK){
            screen_off=!screen_off;
            if(page==PAGE_CLOCK && page_locked){
        clk_screen_off=0;clk_activity_at=esp_timer_get_time();clk_apply_brightness();
      }else{bsp_display_backlight(screen_off?0:SCREEN_BACKLIGHT_PERCENT);}
            piko_voice_key_reset(&voice_key);
        }
        return;
    }
  unsigned button=key.key==BSP_BTN_OK?PIKO_OK:key.key==BSP_BTN_UP?PIKO_UP:PIKO_DOWN;
  unsigned event=key.event==BSP_BTN_PRESS?PIKO_PRESS:key.event==BSP_BTN_RELEASE?PIKO_RELEASE:key.event==BSP_BTN_LONG?PIKO_LONG:PIKO_CLICK;
  xSemaphoreTake(mutex,portMAX_DELAY);
  bool busy=model.voice_busy;char stage[24];copy_text(stage,sizeof(stage),model.voice_stage);
  xSemaphoreGive(mutex);
  if(page==PAGE_INPUT && page_locked && button==PIKO_DOWN){
    if(event==PIKO_PRESS)input_down_long=false;
    if(event==PIKO_LONG){input_down_long=true;return;}
    if(event==PIKO_CLICK && input_down_long){input_down_long=false;return;}
  }
  if(page==PAGE_PIKO && button!=PIKO_OK){
    if(event==PIKO_PRESS)volume_click_suppressed=false;
    if(event==PIKO_CLICK && volume_click_suppressed){volume_click_suppressed=false;return;}
  }
  if(page==PAGE_CALENDAR && button!=PIKO_OK){
    if(event==PIKO_PRESS)cal_click_suppressed=false;
    if(event==PIKO_CLICK && cal_click_suppressed){cal_click_suppressed=false;return;}
  }
  if(page==PAGE_CLOCK && page_locked && clk_screen_off){
    clk_screen_off=0;clk_apply_brightness();return;  // 任意键唤醒，且不触发功能
  }
  if(page==PAGE_CLOCK && button!=PIKO_OK){
    if(event==PIKO_PRESS)clk_click_suppressed=false;
    if(event==PIKO_CLICK && clk_click_suppressed){clk_click_suppressed=false;return;}
  }
  int action=piko_control(page,page_locked,button,event,busy,stage);
  if(page==PAGE_PIKO && button==PIKO_OK && event==PIKO_PRESS && action!=PIKO_RECORD_PRESS)
    piko_voice_key_reset(&voice_key);
  if(button!=PIKO_OK && event==PIKO_RELEASE){volume_direction=0;volume_repeat_at=0;cal_direction=0;cal_repeat_at=0;clk_direction=0;clk_repeat_at=0;}
  switch(action){
  case PIKO_ENTER:
    piko_voice_key_reset(&voice_key);text_page_index=0;
    if(page==PAGE_INPUT && !wifi_ready)return;
    if((page==PAGE_INPUT||page==PAGE_PIKO)&&!audio_mode_acquire())return;
    if(page==PAGE_INPUT && !voice_input_select()){audio_mode_release();return;}
    if(page==PAGE_PIKO){
      snprintf(chat_session,sizeof(chat_session),"%s-chat-%u",boot_id,++chat_session_sequence);
      chat_session_started=esp_timer_get_time();
    }
    if(page==PAGE_CALENDAR)cal_enter_today();
    if(page==PAGE_CLOCK){clk_menu_open=0;clk_activity_at=esp_timer_get_time();clk_apply_brightness();}
    if(page==PAGE_PAGER){
        if(!audio_mode_release()){pager_start_failed=true;return;}
        atomic_store(&desktop_suspended,true);
        for(unsigned wait=0;wait<100&&!atomic_load(&desktop_pause_ready);wait++)vTaskDelay(pdMS_TO_TICKS(10));
        pager_start_failed=!atomic_load(&desktop_pause_ready)||!pager_page_open();
        if(pager_start_failed)return;
      }
    page_locked=true;atomic_store(&volume_controls,page==PAGE_PIKO||page==PAGE_PAGER);return;
  case PIKO_PREV_PAGE:case PIKO_NEXT_PAGE:
    if(page==PAGE_INPUT)voice_input_close();
    if((page==PAGE_INPUT||page==PAGE_PIKO)&&!audio_mode_release())return;
    if(page==PAGE_PAGER && !pager_page_close())return;
    page=(page+(action==PIKO_PREV_PAGE?PAGE_COUNT-1:1))%PAGE_COUNT;
    text_page_index=0;settings_view=VIEW_MAIN;
    atomic_store(&input_selected,page==PAGE_INPUT);
      atomic_store(&desktop_suspended,page==PAGE_INPUT||page==PAGE_PAGER);
    if(page==PAGE_INPUT)voice_input_open();
    return;
  case PIKO_EXIT:
    if(page==PAGE_PIKO && !piko_voice_key_click(&voice_key))return;
    if(page==PAGE_PIKO && busy)voice_cancel();
    if(page==PAGE_INPUT){voice_input_close();voice_input_open();}
    if((page==PAGE_INPUT||page==PAGE_PIKO)&&!audio_mode_release())return;
    if(page==PAGE_CLOCK){clk_screen_off=0;bsp_display_backlight(screen_off?0:SCREEN_BACKLIGHT_PERCENT);}
    page_locked=false;volume_direction=0;cal_direction=0;clk_direction=0;clk_menu_open=0;atomic_store(&volume_controls,false);piko_voice_key_reset(&voice_key);return;
  case PIKO_RECORD_PRESS:piko_voice_key_press(&voice_key,esp_timer_get_time(),false);return;
  case PIKO_RECORD_RELEASE:
    if(piko_voice_key_release(&voice_key) && busy && strcmp(stage,"listening")==0){passport_audio_stop_record();voice_stop_requested=true;}return;
  case PIKO_TEXT_PREV:case PIKO_TEXT_NEXT:
    if(text_page_count)text_page_index=(text_page_index+text_page_count+(action==PIKO_TEXT_PREV?-1:1))%text_page_count;
    return;
  case PIKO_VOLUME_UP:case PIKO_VOLUME_DOWN:
    volume_click_suppressed=true;adjust_volume(action==PIKO_VOLUME_UP);volume_direction=action==PIKO_VOLUME_UP?1:-1;volume_repeat_at=esp_timer_get_time()+350000;return;
  case PIKO_CAL_PREV:case PIKO_CAL_NEXT:
    // CLICK 事件在 RELEASE 之后才到达，此时启动连翻定时器将无人停止；
    // 只有长按（按住期间触发）才允许连翻，短按仅单步。
    if(event==PIKO_LONG){
      cal_click_suppressed=true;
      cal_direction=action==PIKO_CAL_PREV?-1:1;
      cal_repeat_at=esp_timer_get_time()+350000;
    } else cal_direction=0;
    cal_step(action==PIKO_CAL_PREV?-1:1);
    return;
  case PIKO_CAL_TOGGLE:cal_direction=0;cal_toggle();return;
  case PIKO_CLK_UP:case PIKO_CLK_DOWN:{
    bool up=action==PIKO_CLK_UP;
    // 与日历页同理：CLICK 在 RELEASE 之后到达，仅长按路径启动连调
    if(event==PIKO_LONG){clk_click_suppressed=true;clk_direction=up?1:-1;clk_repeat_at=esp_timer_get_time()+350000;}
    else clk_direction=0;
    if(clk_menu_open){clk_menu_row=(clk_menu_row+1)%2;}
    else{
      uint8_t prev=clk_bright;
      clk_bright=piko_clock_bright_step(clk_bright,up);
      if(clk_bright!=prev){clk_apply_brightness();clk_save();}
      clk_bright_until=esp_timer_get_time()+1800000;
    }
    return;}
  case PIKO_CLK_MENU:
    if(clk_menu_open){
      if(clk_menu_row==0)clk_idle_mode=(clk_idle_mode+1)%PIKO_CLK_IDLE_MODES;
      else{clk_bright=piko_clock_bright_step(clk_bright,true);clk_apply_brightness();}
      clk_save();
    }else clk_menu_open=1;
    return;
  case PIKO_PAGER_PREV:case PIKO_PAGER_NEXT:case PIKO_PAGER_OK:case PIKO_PAGER_BACK:
  case PIKO_PAGER_HOLD_UP:case PIKO_PAGER_HOLD_DOWN:
    if(pager_page_key(action,key.event)==PIKO_EXIT && pager_page_close()){
      page_locked=false;atomic_store(&volume_controls,false);
      ESP_LOGI("piko","BLE released heap=%u",(unsigned)esp_get_free_heap_size());
    }
    return;
  case PIKO_APPROVAL_PRESS:
    xSemaphoreTake(mutex,portMAX_DELAY);piko_confirmation_press(&model.confirmation_gate,key.confirmation_epoch);xSemaphoreGive(mutex);return;
  case PIKO_APPROVE:voice_decide(true);voice_key.suppress_click=true;return;
  case PIKO_INPUT_PRESS:voice_input_press();return;
  case PIKO_INPUT_RELEASE:voice_input_release();return;
  case PIKO_INPUT_ENTER:voice_input_enter_key();return;
  default:if(page==PAGE_SETTINGS && page_locked)settings_key(action,key.event);return;
  }
}

#ifdef PIKO_MODE_LIFECYCLE_TEST
#include "../tests/mode_lifecycle_hardware.inc"
#endif

void app_main(void) {
  mutex = xSemaphoreCreateMutex();
  socket_mutex = xSemaphoreCreateMutex();
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
  if(nvs_open("piko",NVS_READONLY,&h)==ESP_OK){
    nvs_get_u8(h,"link_mode",&saved_mode);
    nvs_get_u8(h,"bright5",&clk_bright);
    nvs_get_u8(h,"idlemin",&clk_idle_mode);
    if(nvs_get_u8(h,"volume5",&volume_level)!=ESP_OK){
      uint8_t legacy[3]={0,1,1};size_t un=sizeof(legacy);
      if(nvs_get_blob(h,"uiset",legacy,&un)==ESP_OK && un==sizeof(legacy))
        volume_level=legacy[1]?(legacy[2]<3?legacy[2]+1:2):0;
    }
    nvs_close(h);
  }
  if(volume_level>4)volume_level=2;
  if(clk_bright>4)clk_bright=3;
  if(clk_idle_mode>=PIKO_CLK_IDLE_MODES)clk_idle_mode=1;
  atomic_store(&link_mode,saved_mode==2?2:1);
  page=atomic_load(&link_mode)!=1?PAGE_SETTINGS:PAGE_PIKO;
  ESP_ERROR_CHECK(bsp_i2c_init());
  ESP_ERROR_CHECK(bsp_display_init());
  if (!bsp_lvgl_init())
    abort();
  create_ui();
    clk_apply_brightness();
  ESP_ERROR_CHECK(bsp_button_init(button_event, NULL));
  bool battery_ok = bsp_battery_init() == ESP_OK;
  // Audio buffers and I2S are acquired only on entry to an audio mode.
  audio_ready=false;
  if (!cfg.ssid[0] || force_setup)
    start_setup();
  else
    start_connection();
  int64_t heartbeat_at = 0, battery_at = 0;
#ifdef PIKO_MODE_LIFECYCLE_TEST
  mode_lifecycle_boot_test();
#endif
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
            if (m.setup && !(key.key==BSP_BTN_OK && key.event==BSP_BTN_DOUBLE)) continue;
      handle_key(key,m.wifi_ready);
    }
    int64_t now = esp_timer_get_time();
    if(!m.setup && page_locked && page==PAGE_PIKO && piko_voice_key_tick(&voice_key,now))voice_begin();
    // Keys may have just started recording. Do not run blocking periodic work
    // against the idle snapshot from the beginning of this iteration.
    xSemaphoreTake(mutex,portMAX_DELAY);
    m=model;
    xSemaphoreGive(mutex);
    if (battery_ok && !m.voice_busy && now - battery_at > 10000000) {
      battery = bsp_battery_soc();
      pager_page_set_battery(battery);
      battery_at = now;
    }
    if (m.authenticated && strcmp(m.voice_stage,"listening")!=0 && now - heartbeat_at > 5000000) {
      cJSON *j = packet("heartbeat");
      cJSON_AddNumberToObject(j, "battery", battery);
      cJSON_AddStringToObject(j, "firmware", FW_VERSION);
      send_json(j);
      heartbeat_at = now;
    }
    if(page==PAGE_INPUT){
      voice_input_status_t input=voice_input_status();
      if(input.recording&&!input_prev_rec)input_rec_started=esp_timer_get_time();
      input_prev_rec=input.recording;
      voice_input_tick(m.wifi_ready && !m.setup);
    }
    else voice_tick();
    if(volume_direction && page_locked && page==PAGE_PIKO && now>=volume_repeat_at){
      if(piko_volume_allowed(m.voice_busy,m.voice_stage)){
        adjust_volume(volume_direction>0);volume_repeat_at=now+350000;
      }else volume_direction=0;
    }
    if(cal_direction && page_locked && page==PAGE_CALENDAR && now>=cal_repeat_at){
      cal_step(cal_direction);cal_repeat_at=now+350000;
    }
    if(clk_direction && page_locked && page==PAGE_CLOCK && now>=clk_repeat_at){
      clk_bright=piko_clock_bright_step(clk_bright,clk_direction>0);
      clk_apply_brightness();clk_save();
      clk_bright_until=now+1800000;clk_repeat_at=now+350000;
    }
    if(!screen_off && !clk_screen_off && page_locked && page==PAGE_CLOCK && !m.setup
       && piko_clock_should_sleep(clk_idle_mode,now-clk_activity_at,false)){
      clk_screen_off=1;bsp_display_backlight(0);
    }
    if(page==PAGE_PAGER)pager_page_tick(now);
        if (!screen_off && now - rendered_at >= 100000) {
      render(&m, battery);
      rendered_at = now;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
