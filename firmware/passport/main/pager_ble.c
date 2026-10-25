// BLE HID 外设：一个键盘报告（翻页键）加一个媒体键报告（音量键）。
// GAP 与 HID 初始化流程参考 ESP-IDF examples/bluetooth/esp_hid_device（Unlicense OR CC0-1.0）。
#include "pager_ble.h"

#include <string.h>
#include <stdatomic.h>
#include "esp_bt.h"
#include "esp_hidd.h"
#include "esp_log.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"

static const char *TAG = "pager_ble";

#define APPEARANCE_KEYBOARD 0x03C1
#define HID_SERVICE_UUID    0x1812

static const uint8_t report_map[] = {
    // Keyboard, report ID 1: modifiers, reserved, 6 keys.
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01,
    0x85, PAGER_RPT_KEYBOARD,
    0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
    0x75, 0x01, 0x95, 0x08, 0x81, 0x02,             //   Input: 8 modifier bits
    0x95, 0x01, 0x75, 0x08, 0x81, 0x03,             //   Input: reserved byte
    0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05,
    0x91, 0x02,                                     //   Output: 5 LEDs
    0x95, 0x01, 0x75, 0x03, 0x91, 0x03,             //   Output: padding
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0xFF,
    0x05, 0x07, 0x19, 0x00, 0x29, 0xFF, 0x81, 0x00, //   Input: 6 key codes
    0xC0,
    // Consumer control, report ID 2: one 16-bit usage.
    0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01,
    0x85, PAGER_RPT_CONSUMER,
    0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A, 0xFF, 0x03,
    0x75, 0x10, 0x95, 0x01, 0x81, 0x00,
    0xC0,
};

static esp_hid_raw_report_map_t report_maps[] = {{.data = report_map, .len = sizeof(report_map)}};

static esp_hid_device_config_t hid_config = {
    .vendor_id = 0x16C0,
    .product_id = 0x05DF,
    .version = 0x0100,
    .manufacturer_name = "Passport",
    .serial_number = "0001",
    .report_maps = report_maps,
    .report_maps_len = 1,
};

static esp_hidd_dev_t *s_dev;
static struct ble_hs_adv_fields s_adv_fields;
static ble_uuid16_t s_hid_uuid = BLE_UUID16_INIT(HID_SERVICE_UUID);
static pager_ble_state_cb_t s_state_cb;
static atomic_bool s_stopping,s_host_exited=true;
static bool s_controller_initialized,s_controller_enabled,s_nimble_initialized;
static volatile pager_ble_state_t s_state = PAGER_BLE_ADVERTISING;
static volatile uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static char s_peer_name[PAGER_PEER_NAME_MAX];  // 只在 NimBLE 主机任务里读写

static bool pairing_allowed(const ble_addr_t *peer);

static void set_state(pager_ble_state_t state)
{
    s_state = state;
    if (s_state_cb) s_state_cb(state, s_peer_name);
}

static int gap_event(struct ble_gap_event *event, void *arg);

// 截到完整的 UTF-8 字符为止，避免把一个汉字从中间切开。
static void copy_utf8(char *dst, size_t cap, const uint8_t *src, size_t len)
{
    if (len >= cap) {
        len = cap - 1;
        while (len > 0 && (src[len] & 0xC0) == 0x80) --len;
    }
    memcpy(dst, src, len);
    dst[len] = 0;
}

static int on_peer_name(uint16_t conn, const struct ble_gatt_error *error,
                        struct ble_gatt_attr *attr, void *arg)
{
    (void)arg;
    if (error->status == 0 && attr && attr->om) {
        uint8_t buf[PAGER_PEER_NAME_MAX];
        uint16_t len = 0;
        if (ble_hs_mbuf_to_flat(attr->om, buf, sizeof(buf), &len) == 0 && conn == s_conn) {
            copy_utf8(s_peer_name, sizeof(s_peer_name), buf, len);
            ESP_LOGI(TAG, "Peer name: %s", s_peer_name);
            set_state(s_state);  // 带上名字重新通知界面
        }
    } else if (error->status != BLE_HS_EDONE) {
        ESP_LOGW(TAG, "Peer name not readable (status=%d)", error->status);
    }
    return 0;
}

// 读对方 GAP 服务里的设备名（0x2A00）。Mac、Windows、安卓都会提供。
static void read_peer_name(uint16_t conn)
{
    int rc = ble_gattc_read_by_uuid(conn, 1, 0xFFFF, BLE_UUID16_DECLARE(BLE_SVC_GAP_CHR_UUID16_DEVICE_NAME),
                                    on_peer_name, NULL);
    if (rc != 0) ESP_LOGW(TAG, "read peer name rc=%d", rc);
}

static void adv_start(void)
{
    if(atomic_load(&s_stopping))return;
    if (ble_gap_adv_active()) return;
    int rc = ble_gap_adv_set_fields(&s_adv_fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields rc=%d", rc);
        return;
    }
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = BLE_GAP_ADV_ITVL_MS(30),
        .itvl_max = BLE_GAP_ADV_ITVL_MS(50),
    };
    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv start rc=%d", rc);
        return;
    }
    ESP_LOGI(TAG, "Advertising as %s", hid_config.device_name);
    set_state(PAGER_BLE_ADVERTISING);
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    struct ble_gap_conn_desc desc;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status != 0) {
            ESP_LOGW(TAG, "connect failed status=%d", event->connect.status);
            adv_start();
            return 0;
        }
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->connect.conn_handle, &desc) == 0 &&
            !pairing_allowed(&desc.peer_id_addr)) {
            // 窗口外拒绝陌生设备：已有绑定且对端不在绑定列表里，直接断开。
            ESP_LOGW(TAG, "Rejecting unbonded peer (pairing window closed)");
            ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            return 0;
        }
        s_conn = event->connect.conn_handle;
        s_peer_name[0] = 0;
        ESP_LOGI(TAG, "Connected; requesting encryption");
        set_state(PAGER_BLE_CONNECTED);
        // HID 主机要求加密链路；已配对的设备会直接用保存的密钥。
        ble_gap_security_initiate(s_conn);
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "Disconnected reason=%d", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_peer_name[0] = 0;
        adv_start();
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        if (s_conn == BLE_HS_CONN_HANDLE_NONE) adv_start();
        return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
        if (event->enc_change.status == 0) {
            ESP_LOGI(TAG, "Encrypted; ready to page");
            set_state(PAGER_BLE_READY);
            // 有的主机只在加密后才让读设备名，所以等加密完成再读。
            read_peer_name(event->enc_change.conn_handle);
        } else {
            ESP_LOGW(TAG, "Encryption failed status=%d", event->enc_change.status);
        }
        return 0;
    case BLE_GAP_EVENT_REPEAT_PAIRING:
        // 对方删掉了配对又重新配：丢掉旧密钥，接受新的。
        if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0)
            ble_store_util_delete_peer(&desc.peer_id_addr);
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    case BLE_GAP_EVENT_PASSKEY_ACTION: {
        struct ble_sm_io io = {.action = event->passkey.params.action};
        if (io.action == BLE_SM_IOACT_NUMCMP) io.numcmp_accept = 1;
        ble_sm_inject_io(event->passkey.conn_handle, &io);
        return 0;
    }
    default:
        return 0;
    }
}

static void hidd_event(void *handler_args, esp_event_base_t base, int32_t id, void *event_data)
{
    (void)handler_args; (void)base; (void)event_data;
    switch ((esp_hidd_event_t)id) {
    case ESP_HIDD_START_EVENT:
        adv_start();
        break;
    case ESP_HIDD_DISCONNECT_EVENT:
        adv_start();
        break;
    default:
        break;
    }
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    atomic_store(&s_host_exited,true);
    vTaskDelete(NULL);
}

void ble_store_config_init(void);

// PassportSim 绑定蓝牙模拟时要求镜像里有这两个函数，否则拒绝模拟。翻页器从不关蓝牙，
// 链接器会把它们裁掉，这里留个引用让它们保留下来（只多占几百字节）。
static void *volatile s_keep_for_sim[] = {(void *)esp_bt_controller_disable,
                                          (void *)esp_bt_controller_deinit};

esp_err_t pager_ble_start(const char *name, pager_ble_state_cb_t state_cb)
{
    (void)s_keep_for_sim[0];
    s_state_cb = state_cb;
    if(s_controller_initialized){
        esp_err_t cleanup=pager_ble_stop();if(cleanup!=ESP_OK)return cleanup;
    }
    atomic_store(&s_stopping,false);
    hid_config.device_name = name;

    esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    esp_err_t result=esp_bt_controller_init(&cfg);
    if(result!=ESP_OK)return result;
    s_controller_initialized=true;
    result=esp_bt_controller_enable(ESP_BT_MODE_BLE);
    if(result!=ESP_OK)goto cleanup_controller;
    s_controller_enabled=true;
    result=esp_nimble_init();
    if(result!=ESP_OK)goto cleanup_enabled;
    s_nimble_initialized=true;
    memset(&s_adv_fields, 0, sizeof(s_adv_fields));
    s_adv_fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    s_adv_fields.appearance = APPEARANCE_KEYBOARD;
    s_adv_fields.appearance_is_present = 1;
    s_adv_fields.name = (uint8_t *)name;
    s_adv_fields.name_len = strlen(name);
    s_adv_fields.name_is_complete = 1;
    s_adv_fields.uuids16 = &s_hid_uuid;
    s_adv_fields.num_uuids16 = 1;
    s_adv_fields.uuids16_is_complete = 1;

    // 无屏幕输入的"直接配对"，配对信息保存在 NVS，下次自动回连。
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ID | BLE_SM_PAIR_KEY_DIST_ENC;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ID | BLE_SM_PAIR_KEY_DIST_ENC;

    result=esp_hidd_dev_init(&hid_config,ESP_HID_TRANSPORT_BLE,hidd_event,&s_dev);
    if(result!=ESP_OK)goto cleanup_nimble;
    // 读到真实电量前先报 100%，免得电脑上一连上就提示电量低。
    esp_hidd_dev_battery_set(s_dev, 100);
    ble_svc_gap_device_name_set(name);
    ble_svc_gap_device_appearance_set(APPEARANCE_KEYBOARD);

    ble_store_config_init();
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    atomic_store(&s_host_exited,false);
    if(xTaskCreate(host_task,"piko_ble",CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE,NULL,
                   configMAX_PRIORITIES-4,NULL)!=pdPASS){
        atomic_store(&s_host_exited,true);
        result=ESP_ERR_NO_MEM;goto cleanup_hid;
    }
    return ESP_OK;
cleanup_hid:
cleanup_nimble:
cleanup_enabled:
cleanup_controller:
    {
        esp_err_t cleanup=pager_ble_stop();
        if(cleanup!=ESP_OK)ESP_LOGE(TAG,"Init rollback pending: %s",esp_err_to_name(cleanup));
    }
    return result;
}

esp_err_t pager_ble_stop(void)
{
    if(!s_controller_initialized)return ESP_OK;
    atomic_store(&s_stopping,true);
    if(!atomic_load(&s_host_exited)){
        if(ble_gap_adv_active())ble_gap_adv_stop();
        int rc=nimble_port_stop();
        if(rc!=0){ESP_LOGE(TAG,"Host stop failed rc=%d",rc);return ESP_FAIL;}
        for(unsigned wait=0;!atomic_load(&s_host_exited);wait++){
            if(wait>=200)return ESP_ERR_TIMEOUT;
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    // Host no longer accesses GATT services. Destroy HID/event loop before NPL.
    if(s_dev){
        esp_err_t result=esp_hidd_dev_deinit(s_dev);
        if(result!=ESP_OK)return result;
        s_dev=NULL;
    }
    if(s_nimble_initialized){
        esp_err_t result=esp_nimble_deinit();
        if(result!=ESP_OK)return result;
        s_nimble_initialized=false;
    }
    if(s_controller_enabled){
        esp_err_t result=esp_bt_controller_disable();
        if(result!=ESP_OK)return result;
        s_controller_enabled=false;
    }
    esp_err_t result=esp_bt_controller_deinit();
    if(result!=ESP_OK)return result;
    s_controller_initialized=false;
    s_conn=BLE_HS_CONN_HANDLE_NONE;s_peer_name[0]=0;
    set_state(PAGER_BLE_ADVERTISING);
    // Let idle reap the host task stack before the next mode allocates buffers.
    vTaskDelay(pdMS_TO_TICKS(1));
    return ESP_OK;
}

static bool send(pager_key_t key, bool down)
{
    if (key.report_id == PAGER_RPT_CONSUMER) {
        uint8_t report[2] = {0};
        if (down) {
            report[0] = key.code & 0xFF;
            report[1] = key.code >> 8;
        }
        return esp_hidd_dev_input_set(s_dev, 0, PAGER_RPT_CONSUMER, report, sizeof(report))==ESP_OK;
    } else {
        uint8_t report[8] = {0};
        if (down) {
            report[0] = key.modifier;
            report[2] = (uint8_t)key.code;
        }
        return esp_hidd_dev_input_set(s_dev, 0, PAGER_RPT_KEYBOARD, report, sizeof(report))==ESP_OK;
    }
}

// —— 放映控制：键盘报告的组合键（0x07 页键值，修饰键在报告第 0 字节）——
#define HID_MOD_LSHIFT 0x02
#define HID_MOD_LALT   0x04
#define HID_MOD_LGUI   0x08
#define KEY_RETURN     0x28
#define KEY_ESC        0x29
#define KEY_B          0x05
#define KEY_F5         0x3E
#define KEY_P          0x13
#define COMBO_HOLD_MS  120  // 按下保持时长，含组合键
#define COMBO_GAP_MS   200  // 连续组合键之间的间隔

static void combo(uint8_t modifier, uint8_t keycode)
{
    if (s_state != PAGER_BLE_READY || !s_dev) return;
    pager_key_t key = {PAGER_RPT_KEYBOARD, keycode, modifier};
    send(key, true);
    vTaskDelay(pdMS_TO_TICKS(COMBO_HOLD_MS));
    send(key, false);
    vTaskDelay(pdMS_TO_TICKS(30));
}

void pager_ble_slideshow_start(void)
{
    // 任一平台命中即生效：Windows PowerPoint/WPS/LibreOffice 认 F5，
    // macOS Keynote 认 Cmd+Shift+Return，部分放映软件认 Cmd+Alt+P。
    combo(0, KEY_F5);
    vTaskDelay(pdMS_TO_TICKS(COMBO_GAP_MS));
    combo(HID_MOD_LGUI | HID_MOD_LSHIFT, KEY_RETURN);
    vTaskDelay(pdMS_TO_TICKS(COMBO_GAP_MS));
    combo(HID_MOD_LGUI | HID_MOD_LALT, KEY_P);
}

void pager_ble_slideshow_exit(void)
{
    combo(0, KEY_ESC);
}

void pager_ble_blackscreen_tap(void)
{
    combo(0, KEY_B);
}

bool pager_ble_tap(pager_key_t key)
{
    if(s_state!=PAGER_BLE_READY || !s_dev)return false;
    bool down=send(key,true);
    if(down)vTaskDelay(pdMS_TO_TICKS(30));
    // Always attempt key-up, even after an uncertain press result.
    bool up=send(key,false);
    return down&&up;
}

// —— 配对窗口：已有绑定后，窗口外拒绝陌生新设备配对（首台与已绑定回连不受限）——
// NimBLE 没有内建的“拒绝新绑定”开关，在连接建立时查对端是否已绑定，不是就断开。
static TickType_t s_window_until;  // 非 0 表示窗口开到这个时刻

void pager_ble_open_pairing_window(uint32_t ms)
{
    s_window_until = xTaskGetTickCount() + pdMS_TO_TICKS(ms);
    ESP_LOGI(TAG, "Pairing window open for %lums", (unsigned long)ms);
}

bool pager_ble_pairing_open(void)
{
    return s_window_until != 0 && (int32_t)(xTaskGetTickCount() - s_window_until) <= 0;
}

int pager_ble_bond_count(void)
{
    ble_addr_t addrs[8];
    int n = 0;
    if (ble_store_util_bonded_peers(addrs, &n, 8) != 0) return -1;  // 查不到就当未知
    return n;
}

// 允许建链的三种情况：配对窗口开着；还没有任何绑定（首台设备）；对端本身已绑定（回连）。
static bool pairing_allowed(const ble_addr_t *peer)
{
    if (pager_ble_pairing_open()) return true;
    ble_addr_t addrs[8];
    int n = 0;
    if (ble_store_util_bonded_peers(addrs, &n, 8) != 0) return true;
    if (n == 0) return true;
    for (int i = 0; i < n; ++i)
        if (ble_addr_cmp(&addrs[i], peer) == 0) return true;
    return false;
}

pager_ble_state_t pager_ble_state(void) { return s_state; }

void pager_ble_set_battery(int percent)
{
    if (s_dev && percent >= 0 && percent <= 100) esp_hidd_dev_battery_set(s_dev, (uint8_t)percent);
}

void pager_ble_forget_all(void)
{
    ESP_LOGI(TAG, "Forgetting all bonds");
    s_window_until = 0;
    if (s_conn != BLE_HS_CONN_HANDLE_NONE) ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
    ble_store_clear();
}
