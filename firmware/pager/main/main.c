// Passport Pager：把 AI Passport 变成蓝牙翻页器（v2 状态主导 UI）。
// 五个状态在版式与配色上结构不同：
//   引导（等待配对）→ 主态（模式 hero + 按键闪光带）→ 放映（反色计时，整页接管）
//   → 黑屏（放映中 OK）→ 模式抽屉（主态上的覆盖层，OK 双击呼出）。
// 清除配对：上长按 → 下长按（2 秒内）。
#include <assert.h>
#include <inttypes.h>
#include <string.h>
#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "lvgl.h"
#include "misc/lv_text_private.h"  // lv_text_encoded_next：逐个解码 UTF-8 码点
#include "nvs.h"
#include "nvs_flash.h"
#include "pager_ble.h"
#include "pager_keys.h"

static const char *TAG = "passport_pager";
#define DEVICE_NAME "Passport Pager"

#define SHEET_TIMEOUT_MS   5000
#define SHEET_WINDOW_MS    120000  // 抽屉里长按 OK 开启的配对窗口
#define FLASH_MS           800
#define DIM_PRESENT_MS     120000  // 放映中无操作调暗
#define DIM_MAIN_MS        60000   // 非放映无操作调暗
#define CLEAR_COMBO_MS     2000    // 上长按 → 下长按 的时间窗
#define BATTERY_POLL_MS    30000
#define BACKLIGHT_NORMAL   60
#define BACKLIGHT_PRESENT  6
#define BACKLIGHT_MAIN_DIM 20

// 主题（与 Piko 固件同一套）
#define C_BG        0xF6F1E7
#define C_INK       0x315446
#define C_MUTED     0x70806D
#define C_DIS       0xAAB0A5
#define C_ACC       0x315E49
#define C_CARD      0xFFFFFF
#define C_BORDER    0xE3E5D8
#define C_AMBER     0xA3722F
#define C_DARK_BG   0x22332B
#define C_BLACK_BG  0x0E1512
#define C_DARK_PEEL 0x8FA79B  // 深底上的次级文字
#define C_LOW_BATT  0xB3573F

typedef enum { EV_PREV, EV_NEXT, EV_OK_CLICK, EV_OK_DOUBLE, EV_OK_LONG,
               EV_UP_LONG, EV_DOWN_LONG, EV_BLE } ev_kind_t;
typedef struct {
    ev_kind_t kind;
    pager_ble_state_t ble;
    char peer[PAGER_PEER_NAME_MAX];
} ev_t;

typedef enum { VIEW_GUIDE = 0, VIEW_MAIN, VIEW_PRESENT, VIEW_BLACKOUT } view_t;

static QueueHandle_t s_events;
static view_t s_view = VIEW_GUIDE;
static pager_ble_state_t s_ble = PAGER_BLE_ADVERTISING;
static char s_peer[PAGER_PEER_NAME_MAX];
static int s_battery = -1;
static pager_mode_t s_pager_mode = PAGER_MODE_ARROW;

static bool s_present;             // 放映接管中（VIEW_PRESENT / VIEW_BLACKOUT 都算）
static bool s_black;               // 放映中按了 OK，主机黑屏
static bool s_sheet;               // 模式抽屉可见
static int s_sheet_sel;
static TickType_t s_sheet_deadline;
static TickType_t s_flash_deadline;
static TickType_t s_last_activity;
static bool s_dimmed;
static TickType_t s_clear_up_at;   // 上键长按时刻，等下键长按凑组合
static int64_t s_pres_start_us;
static int s_timer_cache = -1;

// 顶部状态条（跨视图常驻）
static lv_obj_t *s_peer_lbl, *s_batt_lbl;
// 引导
static lv_obj_t *v_guide, *g_herald, *g_big, *g_card, *g_card_txt, *g_legend;
// 主态
static lv_obj_t *v_main, *m_glyphs, *m_mode, *m_hint, *m_flash, *m_flash_txt, *m_legend;
// 放映
static lv_obj_t *v_present, *p_timer, *p_hint, *p_dimnote;
// 黑屏
static lv_obj_t *v_black, *b_dot, *b_wake;
// 模式抽屉
static lv_obj_t *s_veil, *s_panel, *s_foot;
static lv_obj_t *s_row[3], *s_row_check[3], *s_row_name[3], *s_row_tag[3];

// —— 字体 ——
// 中文用 tools/gen_fonts.sh 生成的子集：16px 正文，24px 大字（GB2312 一级常用字兜底）。
LV_FONT_DECLARE(pager_font_16);
LV_FONT_DECLARE(pager_font_24);
static lv_font_t s_font, s_big;

static const char *const STATUS_GUIDE = "等待配对";
#define TXT_FORGET   "配对已清除"
#define TXT_WINDOW   "配对窗口已开启"
#define TXT_OFFLINE  "未连接，先在蓝牙里配对"
#define TXT_NEXT     "下一页"
#define TXT_PREV     "上一页"
#define TXT_CARD     "打开电脑或手机的蓝牙设置\n选择 Passport Pager 连接"
#define TXT_LEGEND_G "无需配对码，配对一次自动记住"
#define TXT_LEGEND_M "上/下 翻页　OK双击 切换模式"
#define TXT_PRESENT  "放映中"
#define TXT_PHINT    "OK 黑屏　长按 退出"
#define TXT_DIM      "久无操作自动调暗，按键即醒"
#define TXT_WAKE     "已黑屏　按 OK 恢复"
#define TXT_SHEET    "翻页方式"
#define TXT_SFOOT    "上下选择　OK 确认　5秒返回"
#define TXT_TAG_VOL  "音量键"

static void fonts_init(void)
{
    s_font = pager_font_16;
    s_font.fallback = &lv_font_montserrat_16;
    s_big = pager_font_24;
    s_big.fallback = &lv_font_montserrat_20;
}

// 启动时把界面上所有固定文案逐字查一遍，缺字记到日志里（U+XXXX）。
static void check_glyphs(void)
{
    const char *texts[] = {
        STATUS_GUIDE, TXT_FORGET, TXT_WINDOW, TXT_OFFLINE, TXT_NEXT, TXT_PREV,
        TXT_CARD, TXT_LEGEND_G, TXT_LEGEND_M, TXT_PRESENT, TXT_PHINT, TXT_DIM,
        TXT_WAKE, TXT_SHEET, TXT_SFOOT, TXT_TAG_VOL, "0123456789%-:/+",
        LV_SYMBOL_BLUETOOTH LV_SYMBOL_BATTERY_FULL LV_SYMBOL_BATTERY_3
            LV_SYMBOL_BATTERY_2 LV_SYMBOL_BATTERY_1 LV_SYMBOL_BATTERY_EMPTY
            LV_SYMBOL_LEFT LV_SYMBOL_RIGHT LV_SYMBOL_OK,
        pager_mode_name(0), pager_mode_name(1), pager_mode_name(2),
        pager_mode_hint(0), pager_mode_hint(1), pager_mode_hint(2),
        "音量 + / -", "PgUp / PgDn", "NoteX6", "已连接",
    };
    int missing = 0, checked = 0;
    for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); ++i) {
        uint32_t ofs = 0;
        while (texts[i][ofs]) {
            uint32_t cp = lv_text_encoded_next(texts[i], &ofs);
            if (cp < 0x20) continue;
            const lv_font_t *fonts[] = {&s_font, &s_big};
            for (int f = 0; f < 2; ++f) {
                lv_font_glyph_dsc_t g = {0};
                ++checked;
                if (!lv_font_get_glyph_dsc(fonts[f], &g, cp, 0) || g.is_placeholder) {
                    ESP_LOGW(TAG, "Missing glyph U+%04" PRIX32 " (%dpx)", cp, f ? 24 : 16);
                    ++missing;
                }
            }
        }
    }
    ESP_LOGI(TAG, "Glyph check: %d of %d glyphs missing", missing, checked);
}

// —— 小工具 ——

static void set_hidden(lv_obj_t *obj, bool hidden)
{
    if (hidden) lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
}

static lv_obj_t *mk_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    return l;
}

static lv_obj_t *mk_panel(lv_obj_t *parent, int x, int y, int w, int h, int radius,
                          uint32_t bg, lv_opa_t bg_opa, uint32_t border)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_set_style_border_width(o, border ? 1 : 0, 0);
    lv_obj_set_style_border_color(o, lv_color_hex(border), 0);
    lv_obj_set_style_bg_color(o, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_opa(o, bg_opa, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    return o;
}

static const char *batt_icon(void)
{
    return s_battery < 0   ? LV_SYMBOL_BATTERY_EMPTY
           : s_battery >= 80 ? LV_SYMBOL_BATTERY_FULL
           : s_battery >= 55 ? LV_SYMBOL_BATTERY_3
           : s_battery >= 30 ? LV_SYMBOL_BATTERY_2
           : s_battery >= 10 ? LV_SYMBOL_BATTERY_1
                             : LV_SYMBOL_BATTERY_EMPTY;
}

static uint64_t now_ms(void) { return (uint64_t)(esp_timer_get_time() / 1000); }

// 调用方必须持有 LVGL 锁。
static void render(void)
{
    const bool dark = s_view == VIEW_PRESENT;
    const bool black = s_view == VIEW_BLACKOUT;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(black ? C_BLACK_BG : dark ? C_DARK_BG : C_BG), 0);

    set_hidden(v_guide, s_view != VIEW_GUIDE);
    set_hidden(v_main, s_view != VIEW_MAIN);
    set_hidden(v_present, s_view != VIEW_PRESENT);
    set_hidden(v_black, s_view != VIEW_BLACKOUT);

    // 顶部状态条：引导态只显电量；连接对象名在深底上换浅色。
    set_hidden(s_peer_lbl, s_view == VIEW_GUIDE || s_ble == PAGER_BLE_ADVERTISING);
    char peer[PAGER_PEER_NAME_MAX + 8];
    memcpy(peer, LV_SYMBOL_BLUETOOTH, 4);
    strlcpy(peer + 4, s_peer[0] ? s_peer : "已连接", sizeof(peer) - 4);
    lv_label_set_text(s_peer_lbl, peer);
    lv_obj_set_style_text_color(s_peer_lbl,
        lv_color_hex(dark || black ? C_DARK_PEEL : C_ACC), 0);
    char batt[24];
    if (s_battery < 0) snprintf(batt, sizeof(batt), "%s --", batt_icon());
    else snprintf(batt, sizeof(batt), "%s %d%%", batt_icon(), s_battery);
    lv_label_set_text(s_batt_lbl, batt);
    lv_obj_set_style_text_color(s_batt_lbl,
        lv_color_hex(s_battery >= 0 && s_battery < 15 ? C_LOW_BATT
                     : dark || black ? C_DARK_PEEL : C_MUTED), 0);

    // 模式抽屉：主态上的覆盖层。
    const bool sheet_on = s_sheet && s_view == VIEW_MAIN;
    set_hidden(s_veil, !sheet_on);
    set_hidden(s_panel, !sheet_on);
    if (sheet_on) {
        for (int k = 0; k < (int)PAGER_MODE_COUNT; ++k) {
            const bool sel = k == s_sheet_sel;
            lv_obj_set_style_bg_opa(s_row[k], sel ? LV_OPA_10 : LV_OPA_TRANSP, 0);
            set_hidden(s_row_check[k], !sel);
        }
    }
}

static void render_flash(const char *text, uint32_t color)
{
    if (bsp_lvgl_lock(100)) {
        lv_label_set_text(m_flash_txt, text);
        lv_obj_set_style_text_color(m_flash_txt, lv_color_hex(color), 0);
        lv_obj_set_style_border_color(m_flash, lv_color_hex(color), 0);
        lv_obj_remove_flag(m_flash, LV_OBJ_FLAG_HIDDEN);
        bsp_lvgl_unlock();
    }
    s_flash_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(FLASH_MS);
}

static void render_async(void)
{
    if (bsp_lvgl_lock(100)) {
        render();
        bsp_lvgl_unlock();
    }
}

// —— UI 构建 ——

static void build_guide(lv_obj_t *parent)
{
    g_herald = mk_label(parent, &lv_font_montserrat_48, C_AMBER);
    lv_label_set_text(g_herald, LV_SYMBOL_BLUETOOTH);
    lv_obj_align(g_herald, LV_ALIGN_TOP_MID, 0, 48);

    g_big = mk_label(parent, &s_big, C_INK);
    lv_label_set_text(g_big, STATUS_GUIDE);
    lv_obj_align(g_big, LV_ALIGN_TOP_MID, 0, 132);

    g_card = mk_panel(parent, 20, 184, 200, 68, 12, C_CARD, LV_OPA_70, C_BORDER);
    g_card_txt = mk_label(g_card, &s_font, C_MUTED);
    lv_label_set_text(g_card_txt, TXT_CARD);
    lv_label_set_long_mode(g_card_txt, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(g_card_txt, 184);
    lv_obj_set_style_text_align(g_card_txt, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(g_card_txt, 4, 0);
    lv_obj_center(g_card_txt);

    g_legend = mk_label(parent, &s_font, C_MUTED);
    lv_label_set_text(g_legend, TXT_LEGEND_G);
    lv_obj_align(g_legend, LV_ALIGN_BOTTOM_MID, 0, -16);
}

// hero 大符号按模式切换：方向键用 48px 箭头，其余用 24px 文本（字库覆盖）。
static void render_hero(void)
{
    switch (s_pager_mode) {
    case PAGER_MODE_PAGE:
        lv_obj_set_style_text_font(m_glyphs, &s_big, 0);
        lv_label_set_text(m_glyphs, "PgUp / PgDn");
        break;
    case PAGER_MODE_VOLUME:
        lv_obj_set_style_text_font(m_glyphs, &s_big, 0);
        lv_label_set_text(m_glyphs, "音量 + / -");
        break;
    case PAGER_MODE_ARROW:
    default:
        lv_obj_set_style_text_font(m_glyphs, &lv_font_montserrat_48, 0);
        lv_label_set_text(m_glyphs, LV_SYMBOL_LEFT "  " LV_SYMBOL_RIGHT);
        break;
    }
    lv_obj_set_style_text_color(m_glyphs, lv_color_hex(C_ACC), 0);
    lv_label_set_text(m_mode, pager_mode_name(s_pager_mode));
    lv_label_set_text(m_hint, pager_mode_hint(s_pager_mode));
}

static void build_main(lv_obj_t *parent)
{
    m_glyphs = mk_label(parent, &lv_font_montserrat_48, C_ACC);
    lv_obj_align(m_glyphs, LV_ALIGN_TOP_MID, 0, 44);

    m_mode = mk_label(parent, &s_big, C_INK);
    lv_obj_align(m_mode, LV_ALIGN_TOP_MID, 0, 116);

    m_hint = mk_label(parent, &s_font, C_MUTED);
    lv_obj_align(m_hint, LV_ALIGN_TOP_MID, 0, 156);

    m_flash = mk_panel(parent, 24, 194, 192, 42, 14, C_ACC, LV_OPA_10, C_ACC);
    lv_obj_set_style_border_opa(m_flash, LV_OPA_30, 0);
    m_flash_txt = mk_label(m_flash, &s_font, C_ACC);
    lv_obj_center(m_flash_txt);
    lv_obj_add_flag(m_flash, LV_OBJ_FLAG_HIDDEN);

    m_legend = mk_label(parent, &s_font, C_MUTED);
    lv_label_set_text(m_legend, TXT_LEGEND_M);
    lv_obj_align(m_legend, LV_ALIGN_BOTTOM_MID, 0, -16);

    render_hero();
}

static void build_present(lv_obj_t *parent)
{
    lv_obj_t *live = mk_panel(parent, 74, 48, 92, 28, 14, C_AMBER, LV_OPA_20, 0);
    lv_obj_t *live_txt = mk_label(live, &s_font, C_AMBER);
    lv_label_set_text(live_txt, TXT_PRESENT);
    lv_obj_center(live_txt);

    p_timer = mk_label(parent, &lv_font_montserrat_48, C_BG);
    lv_label_set_text(p_timer, "00:00");
    lv_obj_align(p_timer, LV_ALIGN_TOP_MID, 0, 106);

    p_hint = mk_label(parent, &s_font, 0xAFC2B8);
    lv_label_set_text(p_hint, TXT_PHINT);
    lv_obj_align(p_hint, LV_ALIGN_TOP_MID, 0, 186);

    p_dimnote = mk_label(parent, &s_font, 0x55685E);
    lv_label_set_text(p_dimnote, TXT_DIM);
    lv_obj_align(p_dimnote, LV_ALIGN_BOTTOM_MID, 0, -16);
}

static void build_black(lv_obj_t *parent)
{
    b_dot = lv_obj_create(parent);
    lv_obj_remove_flag(b_dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(b_dot, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_size(b_dot, 6, 6);
    lv_obj_set_style_radius(b_dot, 3, 0);
    lv_obj_set_style_border_width(b_dot, 0, 0);
    lv_obj_set_style_bg_color(b_dot, lv_color_hex(0x39453E), 0);
    lv_obj_set_style_bg_opa(b_dot, LV_OPA_COVER, 0);
    lv_obj_align(b_dot, LV_ALIGN_CENTER, 0, 0);

    b_wake = mk_label(parent, &s_font, 0x39453E);
    lv_label_set_text(b_wake, TXT_WAKE);
    lv_obj_align(b_wake, LV_ALIGN_BOTTOM_MID, 0, -24);
}

static void build_sheet(lv_obj_t *screen)
{
    s_veil = mk_panel(screen, 0, 0, 240, 320, 0, 0x315446, LV_OPA_30, 0);
    s_panel = mk_panel(screen, 10, 126, 220, 184, 16, C_CARD, LV_OPA_COVER, C_BORDER);

    lv_obj_t *title = mk_label(s_panel, &s_font, C_INK);
    lv_label_set_text(title, TXT_SHEET);
    lv_obj_set_pos(title, 12, 10);

    static const char *const tags[] = {
        LV_SYMBOL_LEFT "/" LV_SYMBOL_RIGHT, "PgUp/PgDn", TXT_TAG_VOL,
    };
    for (int k = 0; k < (int)PAGER_MODE_COUNT; ++k) {
        s_row[k] = mk_panel(s_panel, 10, 34 + 44 * k, 200, 40, 10, C_ACC, LV_OPA_TRANSP, 0);
        s_row_check[k] = mk_label(s_row[k], &s_font, C_ACC);
        lv_label_set_text(s_row_check[k], LV_SYMBOL_OK);
        lv_obj_align(s_row_check[k], LV_ALIGN_LEFT_MID, 8, 0);
        s_row_name[k] = mk_label(s_row[k], &s_font, C_INK);
        lv_label_set_text(s_row_name[k], pager_mode_name(k));
        lv_obj_align(s_row_name[k], LV_ALIGN_LEFT_MID, 30, 0);
        s_row_tag[k] = mk_label(s_row[k], &s_font, C_MUTED);
        lv_label_set_text(s_row_tag[k], tags[k]);
        lv_obj_align(s_row_tag[k], LV_ALIGN_RIGHT_MID, -8, 0);
    }

    s_foot = mk_label(s_panel, &s_font, C_DIS);
    lv_label_set_text(s_foot, TXT_SFOOT);
    lv_obj_align(s_foot, LV_ALIGN_BOTTOM_MID, 0, -4);
}

static void build_ui(void)
{
    assert(bsp_lvgl_lock(0));
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(C_BG), 0);

    s_peer_lbl = mk_label(screen, &s_font, C_ACC);
    lv_obj_align(s_peer_lbl, LV_ALIGN_TOP_LEFT, 14, 10);
    s_batt_lbl = mk_label(screen, &s_font, C_MUTED);
    lv_obj_align(s_batt_lbl, LV_ALIGN_TOP_RIGHT, -14, 10);

    v_guide = lv_obj_create(screen);
    v_main = lv_obj_create(screen);
    v_present = lv_obj_create(screen);
    v_black = lv_obj_create(screen);
    lv_obj_t *views[] = {v_guide, v_main, v_present, v_black};
    for (unsigned k = 0; k < 4; ++k) {
        lv_obj_remove_flag(views[k], LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_remove_flag(views[k], LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_pos(views[k], 0, 0);
        lv_obj_set_size(views[k], 240, 320);
        lv_obj_set_style_bg_opa(views[k], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(views[k], 0, 0);
        lv_obj_set_style_pad_all(views[k], 0, 0);
        lv_obj_add_flag(views[k], LV_OBJ_FLAG_HIDDEN);
    }
    build_guide(v_guide);
    build_main(v_main);
    build_present(v_present);
    build_black(v_black);
    build_sheet(screen);

    render();
    bsp_lvgl_unlock();
}

// —— 事件 ——

static void on_button(bsp_btn_t button, bsp_btn_ev_t event, void *user)
{
    (void)user;
    ev_t ev = {0};
    if (button == BSP_BTN_UP && event == BSP_BTN_PRESS) ev.kind = EV_PREV;
    else if (button == BSP_BTN_DOWN && event == BSP_BTN_PRESS) ev.kind = EV_NEXT;
    else if (button == BSP_BTN_OK && event == BSP_BTN_CLICK) ev.kind = EV_OK_CLICK;
    else if (button == BSP_BTN_OK && event == BSP_BTN_DOUBLE) ev.kind = EV_OK_DOUBLE;
    else if (button == BSP_BTN_OK && event == BSP_BTN_LONG) ev.kind = EV_OK_LONG;
    else if (button == BSP_BTN_UP && event == BSP_BTN_LONG) ev.kind = EV_UP_LONG;
    else if (button == BSP_BTN_DOWN && event == BSP_BTN_LONG) ev.kind = EV_DOWN_LONG;
    else return;
    (void)xQueueSend(s_events, &ev, 0);
}

static void on_ble_state(pager_ble_state_t state, const char *peer_name)
{
    ev_t ev = {.kind = EV_BLE, .ble = state};
    strlcpy(ev.peer, peer_name, sizeof(ev.peer));
    (void)xQueueSend(s_events, &ev, 0);
}

static void load_mode(void)
{
    nvs_handle_t nvs;
    if (nvs_open("pager", NVS_READONLY, &nvs) != ESP_OK) return;
    uint8_t mode;
    if (nvs_get_u8(nvs, "mode", &mode) == ESP_OK && mode < PAGER_MODE_COUNT) s_pager_mode = mode;
    nvs_close(nvs);
}

static void save_mode(void)
{
    nvs_handle_t nvs;
    if (nvs_open("pager", NVS_READWRITE, &nvs) != ESP_OK) return;
    if (nvs_set_u8(nvs, "mode", s_pager_mode) == ESP_OK) nvs_commit(nvs);
    nvs_close(nvs);
}

static void open_sheet(void)
{
    s_sheet = true;
    s_sheet_sel = (int)s_pager_mode;
    s_sheet_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(SHEET_TIMEOUT_MS);
}

static void close_sheet(void) { s_sheet = false; }

static void start_presentation(void)
{
    pager_ble_slideshow_start();
    s_present = true;
    s_black = false;
    s_pres_start_us = (int64_t)now_ms();
    s_timer_cache = -1;
    s_view = VIEW_PRESENT;
}

static void exit_presentation(bool send_esc)
{
    if (send_esc) pager_ble_slideshow_exit();
    s_present = false;
    s_black = false;
    s_view = s_ble == PAGER_BLE_ADVERTISING ? VIEW_GUIDE : VIEW_MAIN;
}

static void page(pager_dir_t dir)
{
    const bool sent = pager_ble_tap(pager_key_for(s_pager_mode, dir));
    render_flash(sent ? (dir == PAGER_NEXT ? TXT_NEXT : TXT_PREV) : TXT_OFFLINE,
                 sent ? C_ACC : C_AMBER);
    ESP_LOGI(TAG, "%s (%s)", dir == PAGER_NEXT ? "next" : "prev",
             pager_mode_name(s_pager_mode));
}

static void handle(const ev_t *ev)
{
    s_last_activity = xTaskGetTickCount();
    if (s_dimmed) {
        bsp_display_backlight(BACKLIGHT_NORMAL);
        s_dimmed = false;
    }
    switch (ev->kind) {
    case EV_PREV:
    case EV_NEXT: {
        const pager_dir_t dir = ev->kind == EV_NEXT ? PAGER_NEXT : PAGER_PREV;
        if (s_sheet) {  // 抽屉里上下是选择
            s_sheet_sel += dir == PAGER_NEXT ? 1 : -1;
            s_sheet_sel = s_sheet_sel < 0 ? 0
                          : s_sheet_sel >= (int)PAGER_MODE_COUNT ? (int)PAGER_MODE_COUNT - 1
                                                                 : s_sheet_sel;
            s_sheet_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(SHEET_TIMEOUT_MS);
        } else if (s_view == VIEW_BLACKOUT) {
            // 黑屏中不翻页：图例承诺“按 OK 恢复”，箭头键在黑屏下语义不明。
        } else {
            page(dir);
        }
        render_async();
        break;
    }
    case EV_OK_CLICK:
        if (s_sheet) {
            s_pager_mode = (pager_mode_t)s_sheet_sel;
            save_mode();
            close_sheet();
            ESP_LOGI(TAG, "Mode: %s", pager_mode_name(s_pager_mode));
        } else if (s_view == VIEW_BLACKOUT) {
            pager_ble_blackscreen_tap();
            s_black = false;
            s_view = VIEW_PRESENT;
        } else if (s_view == VIEW_PRESENT) {
            pager_ble_blackscreen_tap();
            s_black = true;
            s_view = VIEW_BLACKOUT;
        } else if (s_view == VIEW_MAIN && s_ble != PAGER_BLE_ADVERTISING) {
            start_presentation();
        }
        render_async();
        break;
    case EV_OK_DOUBLE:
        if (s_view == VIEW_MAIN && !s_sheet && !s_present) {
            open_sheet();
            render_async();
        }
        break;
    case EV_OK_LONG:
        if (s_sheet) {
            pager_ble_open_pairing_window(SHEET_WINDOW_MS);
            close_sheet();
            render_flash(TXT_WINDOW, C_ACC);
            render_async();
        } else if (s_view == VIEW_PRESENT || s_view == VIEW_BLACKOUT) {
            exit_presentation(true);
            render_async();
        }
        break;
    case EV_UP_LONG:
        s_clear_up_at = xTaskGetTickCount();
        break;
    case EV_DOWN_LONG:
        if (s_clear_up_at &&
            (int32_t)(xTaskGetTickCount() - s_clear_up_at) < pdMS_TO_TICKS(CLEAR_COMBO_MS)) {
            pager_ble_forget_all();
            s_clear_up_at = 0;
            close_sheet();
            s_present = false;
            s_black = false;
            s_view = VIEW_GUIDE;
            render_flash(TXT_FORGET, C_ACC);
        }
        render_async();
        break;
    case EV_BLE:
        s_ble = ev->ble;
        strlcpy(s_peer, ev->peer, sizeof(s_peer));
        if (s_ble == PAGER_BLE_ADVERTISING) {
            // 掉线/被拒即回到引导态，放映与抽屉一并退出。
            close_sheet();
            s_present = false;
            s_black = false;
            s_view = VIEW_GUIDE;
        } else if (s_view == VIEW_GUIDE) {
            s_view = VIEW_MAIN;
        }
        render_async();
        break;
    }
}

static void poll_battery(void)
{
    int soc = bsp_battery_soc();
    if (soc == s_battery) return;
    s_battery = soc;
    ESP_LOGI(TAG, "Battery: %d%%", soc);
    if (soc >= 0) pager_ble_set_battery(soc);
    render_async();
}

void app_main(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "Running partition: %s", running->label);
    s_events = xQueueCreate(16, sizeof(ev_t));
    assert(s_events);

    // NVS 和官方玩法共用。初始化失败也不擦除，只是记不住配对和模式。
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) ESP_LOGW(TAG, "NVS unavailable (%s); pairing will not persist", esp_err_to_name(err));
    else load_mode();

    ESP_ERROR_CHECK(bsp_display_init());
    assert(bsp_lvgl_init());
    fonts_init();
    check_glyphs();
    build_ui();
    bsp_display_backlight(BACKLIGHT_NORMAL);
    ESP_ERROR_CHECK(bsp_button_init(on_button, NULL));
    // 板子上没有电量计时（比如模拟器）返回 NOT_FOUND，右上角显示 "--"。
    if (bsp_battery_init() != ESP_OK) ESP_LOGW(TAG, "Battery gauge unavailable");
#if CONFIG_PAGER_SIM_NO_BLE
    ESP_LOGW(TAG, "Simulator UI build: Bluetooth not started");
#else
    ESP_ERROR_CHECK(pager_ble_start(DEVICE_NAME, on_ble_state));
#endif

    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK &&
        ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_ERROR_CHECK(esp_ota_mark_app_valid_cancel_rollback());
        ESP_LOGI(TAG, "Trial boot confirmed valid");
    }
    ESP_LOGI(TAG, "Ready: mode=%s", pager_mode_name(s_pager_mode));
    poll_battery();
    TickType_t next_battery = xTaskGetTickCount() + pdMS_TO_TICKS(BATTERY_POLL_MS);
    s_last_activity = xTaskGetTickCount();

    while (true) {
        ev_t ev;
        if (xQueueReceive(s_events, &ev, pdMS_TO_TICKS(200)) == pdTRUE) handle(&ev);
        const TickType_t now = xTaskGetTickCount();

        if (s_flash_deadline && (int32_t)(now - s_flash_deadline) > 0) {
            s_flash_deadline = 0;
            if (bsp_lvgl_lock(100)) {
                lv_obj_add_flag(m_flash, LV_OBJ_FLAG_HIDDEN);
                bsp_lvgl_unlock();
            }
        }
        if (s_sheet && (int32_t)(now - s_sheet_deadline) > 0) {
            close_sheet();
            render_async();
        }
        if (s_present && !s_black) {  // 演讲计时器
            const int sec =
                (int)(((uint64_t)(esp_timer_get_time() / 1000) - (uint64_t)s_pres_start_us) / 1000);
            if (sec != s_timer_cache) {
                s_timer_cache = sec;
                char buf[16];
                if (sec < 3600) snprintf(buf, sizeof(buf), "%02d:%02d", sec / 60, sec % 60);
                else snprintf(buf, sizeof(buf), "%d:%02d:%02d", sec / 3600, sec / 60 % 60, sec % 60);
                if (bsp_lvgl_lock(100)) {
                    lv_label_set_text(p_timer, buf);
                    bsp_lvgl_unlock();
                }
            }
        }
        if (!s_dimmed) {  // 调暗规则：放映 120 秒，其余 60 秒；黑屏本身不调
            const TickType_t idle = now - s_last_activity;
            if (s_view != VIEW_BLACKOUT &&
                ((s_present && idle > pdMS_TO_TICKS(DIM_PRESENT_MS)) ||
                 (!s_present && idle > pdMS_TO_TICKS(DIM_MAIN_MS)))) {
                bsp_display_backlight(s_present ? BACKLIGHT_PRESENT : BACKLIGHT_MAIN_DIM);
                s_dimmed = true;
            }
        }
        if ((int32_t)(now - next_battery) >= 0) {
            next_battery += pdMS_TO_TICKS(BATTERY_POLL_MS);
            poll_battery();
        }
    }
}
