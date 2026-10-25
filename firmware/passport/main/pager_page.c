#include "pager_page.h"

#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "bsp_display.h"
#include "lvgl.h"
#include "pager_ble.h"
#include "pager_keys.h"

static const char *TAG = "pager_page";

// 主题（与 Piko 同套）+ 翻页器状态色
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
#define C_DARK_PEEL 0x8FA79B

#define DEVICE_NAME       "Passport Pager"
#define SHEET_TIMEOUT_US  5000000
#define SHEET_WINDOW_MS   120000
#define FLASH_US          800000
#define DIM_PRESENT_US    120000000
#define DIM_MAIN_US       60000000
#define CLEAR_COMBO_US    2000000
#define BACKLIGHT_NORMAL  65   // 与 Piko SCREEN_BACKLIGHT_PERCENT 一致
#define BACKLIGHT_DIM     20

typedef enum { VIEW_GUIDE = 0, VIEW_MAIN, VIEW_PRESENT, VIEW_BLACKOUT } view_t;

static lv_obj_t *s_cover, *s_zone;
static lv_obj_t *g_root,*m_root,*p_root,*b_root;
static lv_obj_t *g_herald, *g_big, *g_card, *g_card_txt, *g_legend;
static lv_obj_t *m_peer, *m_glyphs, *m_mode, *m_hint, *m_flash, *m_flash_txt;
static lv_obj_t *p_live, *p_timer, *p_hint, *p_dimnote;
static lv_obj_t *b_dot, *b_wake;
static lv_obj_t *s_veil, *s_panel, *s_foot;
static lv_obj_t *s_row[3], *s_row_check[3], *s_row_name[3], *s_row_tag[3];

static view_t s_view = VIEW_GUIDE;
static bool s_started, s_locked, s_present, s_black, s_sheet, s_dimmed, s_dirty = true;
static int s_sheet_sel;
static int s_known_bonds=-1;
static pager_mode_t s_mode = PAGER_MODE_ARROW;
static int64_t s_sheet_deadline, s_flash_deadline, s_pres_start, s_last_activity, s_clear_up_at;
static int s_timer_cache = -1;

static void mode_save(void)
{
    nvs_handle_t nvs;
    if (nvs_open("pager", NVS_READWRITE, &nvs) != ESP_OK) return;
    if (nvs_set_u8(nvs, "mode", (uint8_t)s_mode) == ESP_OK) nvs_commit(nvs);
    nvs_close(nvs);
}

static void mode_load(void)
{
    nvs_handle_t nvs;
    if (nvs_open("pager", NVS_READONLY, &nvs) != ESP_OK) return;
    uint8_t mode;
    if (nvs_get_u8(nvs, "mode", &mode) == ESP_OK && mode < PAGER_MODE_COUNT) s_mode = mode;
    nvs_close(nvs);
}

static SemaphoreHandle_t s_ble_mutex;
static volatile pager_ble_state_t s_ble = PAGER_BLE_ADVERTISING;
static char s_peer[PAGER_PEER_NAME_MAX];

LV_FONT_DECLARE(piko_chinese);
LV_FONT_DECLARE(piko_ui_small);       // 14px
LV_FONT_DECLARE(piko_ui_title);       // 20px
static const lv_font_t *F_SMALL = &piko_ui_small;
static const lv_font_t *F_BIG = &piko_ui_title;
static lv_font_t small_icon_font,big_icon_font,peer_icon_font;

static void set_hidden(lv_obj_t *obj, bool hidden)
{
    if(!obj)return;
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

static const char *const TXT_NEXT = "下一页";
static const char *const TXT_PREV = "上一页";
static const char *const TXT_OFFLINE = "未连接，先在蓝牙里配对";
static const char *const TXT_CARD = "打开电脑或手机的蓝牙设置\n选择 Passport Pager 连接";
static const char *const TXT_PHINT = "上下键翻页 · 短按确认黑屏\n长按确认键结束放映";
static const char *const TXT_WAKE = "短按确认键恢复放映\n长按确认键结束放映";
static const char *const TXT_SHEET = "翻页方式";
static const char *const TXT_SFOOT = "短按确认键保存选择\n长按确认键开放配对";
static const char *const TXT_FORGET = "配对已清除";
static const char *const TXT_WINDOW = "配对窗口已开启";

// —— BLE 状态回调（NimBLE 任务上下文，只做有界拷贝）——

static void on_ble_state(pager_ble_state_t state, const char *peer_name)
{
    xSemaphoreTake(s_ble_mutex, portMAX_DELAY);
    s_ble = state;
    strlcpy(s_peer, peer_name, sizeof(s_peer));
    xSemaphoreGive(s_ble_mutex);
}

static pager_ble_state_t ble_snapshot(char *peer, size_t cap)
{
    xSemaphoreTake(s_ble_mutex, portMAX_DELAY);
    pager_ble_state_t st = s_ble;
    strlcpy(peer, s_peer, cap);
    xSemaphoreGive(s_ble_mutex);
    return st;
}

// —— UI 构建（须持 LVGL 锁；cover 之后的 hint/nav 仍归 Piko）——

static void label_row(lv_obj_t *label,int width,int y,lv_label_long_mode_t mode) {
    lv_obj_set_width(label,width);
    lv_label_set_long_mode(label,mode);
    lv_obj_set_style_text_align(label,LV_TEXT_ALIGN_CENTER,0);
    lv_obj_align(label,LV_ALIGN_TOP_MID,0,y);
}
static lv_obj_t *content_group(lv_obj_t *parent) {
    return mk_panel(parent,0,0,240,168,0,C_BG,LV_OPA_TRANSP,0);
}
static void build_guide(lv_obj_t *parent) {
    g_herald=mk_label(parent,&lv_font_montserrat_36,C_AMBER);
    lv_label_set_text(g_herald,LV_SYMBOL_BLUETOOTH);
    lv_obj_align(g_herald,LV_ALIGN_TOP_MID,0,0);
    g_big=mk_label(parent,F_BIG,C_INK);lv_label_set_text(g_big,"等待配对");
    label_row(g_big,208,47,LV_LABEL_LONG_MODE_DOTS);
    g_card=mk_panel(parent,20,82,200,62,12,C_CARD,LV_OPA_COVER,C_BORDER);
    g_card_txt=mk_label(g_card,F_SMALL,C_MUTED);lv_label_set_text(g_card_txt,TXT_CARD);
    lv_obj_set_width(g_card_txt,180);lv_label_set_long_mode(g_card_txt,LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(g_card_txt,LV_TEXT_ALIGN_CENTER,0);
    lv_obj_set_style_text_line_space(g_card_txt,4,0);lv_obj_center(g_card_txt);
    g_legend=mk_label(parent,F_SMALL,C_MUTED);lv_label_set_text(g_legend,"首次配对无需输入配对码");
    label_row(g_legend,216,151,LV_LABEL_LONG_MODE_DOTS);
}
static void build_main(lv_obj_t *parent) {
    m_peer=mk_label(parent,&peer_icon_font,C_ACC);
    label_row(m_peer,208,0,LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_height(m_peer,peer_icon_font.line_height);
    m_glyphs=mk_label(parent,&lv_font_montserrat_36,C_ACC);
    label_row(m_glyphs,208,32,LV_LABEL_LONG_MODE_DOTS);
    m_mode=mk_label(parent,F_BIG,C_INK);
    label_row(m_mode,208,80,LV_LABEL_LONG_MODE_DOTS);
    m_hint=mk_label(parent,F_SMALL,C_MUTED);
    label_row(m_hint,208,114,LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_height(m_hint,36);
    m_flash=mk_panel(parent,24,112,192,42,12,C_CARD,LV_OPA_COVER,C_BORDER);
    m_flash_txt=mk_label(m_flash,F_SMALL,C_ACC);
    lv_obj_set_width(m_flash_txt,168);lv_label_set_long_mode(m_flash_txt,LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(m_flash_txt,LV_TEXT_ALIGN_CENTER,0);lv_obj_center(m_flash_txt);
    set_hidden(m_flash,true);
}

static void build_present(lv_obj_t *parent)
{
    p_live = mk_panel(parent, 74, 4, 92, 26, 13, C_AMBER, LV_OPA_20, 0);
    lv_obj_t *live_txt = mk_label(p_live, F_SMALL, 0xE6C882);
    lv_label_set_text(live_txt, "放映中");
    lv_obj_center(live_txt);

    p_timer = mk_label(parent, &lv_font_montserrat_36, C_BG);
    lv_label_set_text(p_timer, "00:00");
    lv_obj_align(p_timer, LV_ALIGN_TOP_MID, 0, 52);

    p_hint = mk_label(parent, F_SMALL, 0xAFC2B8);
    lv_label_set_text(p_hint, "上下键翻页");
    lv_obj_align(p_hint, LV_ALIGN_TOP_MID, 0, 112);

    p_dimnote = mk_label(parent, F_SMALL, C_DARK_PEEL);
    lv_label_set_text(p_dimnote, "无操作自动调暗 · 按键唤醒");
    lv_obj_set_width(p_dimnote,216);lv_obj_set_style_text_align(p_dimnote,LV_TEXT_ALIGN_CENTER,0);
    lv_obj_align(p_dimnote, LV_ALIGN_BOTTOM_MID, 0, 0);
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
    lv_obj_align(b_dot, LV_ALIGN_CENTER, 0, -6);

    b_wake = mk_label(parent, F_SMALL, C_DARK_PEEL);
    lv_label_set_text(b_wake, "黑屏");
    lv_obj_align(b_wake, LV_ALIGN_BOTTOM_MID, 0, -8);
}

static void build_sheet(lv_obj_t *parent) {
    s_veil=mk_panel(parent,0,0,240,168,0,C_BG,LV_OPA_COVER,0);
    s_panel=mk_panel(parent,10,4,220,160,14,C_CARD,LV_OPA_COVER,C_BORDER);
    lv_obj_t *heading=mk_label(s_panel,F_SMALL,C_INK);
    lv_label_set_text(heading,TXT_SHEET);lv_obj_set_pos(heading,12,8);
    const char *tags[]={LV_SYMBOL_LEFT " " LV_SYMBOL_RIGHT,"PgUp/PgDn","+ / -"};
    for(int k=0;k<(int)PAGER_MODE_COUNT;k++){
        s_row[k]=mk_panel(s_panel,10,32+k*34,196,30,9,C_ACC,LV_OPA_TRANSP,0);
        s_row_check[k]=mk_label(s_row[k],F_SMALL,C_ACC);
        lv_label_set_text(s_row_check[k],LV_SYMBOL_OK);lv_obj_align(s_row_check[k],LV_ALIGN_LEFT_MID,8,0);
        s_row_name[k]=mk_label(s_row[k],F_SMALL,C_INK);
        lv_label_set_text(s_row_name[k],pager_mode_name((pager_mode_t)k));
        lv_obj_set_width(s_row_name[k],72);lv_label_set_long_mode(s_row_name[k],LV_LABEL_LONG_MODE_DOTS);
        lv_obj_align(s_row_name[k],LV_ALIGN_LEFT_MID,30,0);
        s_row_tag[k]=mk_label(s_row[k],F_SMALL,C_MUTED);lv_label_set_text(s_row_tag[k],tags[k]);
        lv_obj_set_width(s_row_tag[k],82);lv_label_set_long_mode(s_row_tag[k],LV_LABEL_LONG_MODE_DOTS);
        lv_obj_set_style_text_align(s_row_tag[k],LV_TEXT_ALIGN_RIGHT,0);
        lv_obj_align(s_row_tag[k],LV_ALIGN_RIGHT_MID,-6,0);
    }
    s_foot=mk_label(s_panel,F_SMALL,C_MUTED);lv_label_set_text(s_foot,"配对窗口仅开放两分钟");
    lv_obj_set_width(s_foot,196);lv_label_set_long_mode(s_foot,LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_style_text_align(s_foot,LV_TEXT_ALIGN_CENTER,0);lv_obj_align(s_foot,LV_ALIGN_BOTTOM_MID,0,-4);
}

void pager_page_build(lv_obj_t *screen)
{
    assert(bsp_lvgl_lock(0));
    if(!s_ble_mutex)s_ble_mutex = xSemaphoreCreateMutex();
    peer_icon_font=piko_chinese;peer_icon_font.fallback=&lv_font_montserrat_14;
    small_icon_font=piko_ui_small;small_icon_font.fallback=&lv_font_montserrat_14;F_SMALL=&small_icon_font;
    big_icon_font=piko_ui_title;big_icon_font.fallback=&lv_font_montserrat_20;F_BIG=&big_icon_font;
    // cover 盖住状态栏/标题（深色状态时），但压在 hint/nav 之下（它们之后创建）。
    s_cover = mk_panel(screen, 0, 0, 240, 320, 0, C_DARK_BG, LV_OPA_COVER, 0);
    lv_obj_add_flag(s_cover, LV_OBJ_FLAG_HIDDEN);
    s_zone = lv_obj_create(screen);
    lv_obj_set_size(s_zone, 240, 168);
    lv_obj_set_pos(s_zone, 0, 78);
    lv_obj_set_style_pad_all(s_zone, 0, 0);
    lv_obj_set_style_border_width(s_zone, 0, 0);
    lv_obj_set_style_bg_opa(s_zone, LV_OPA_TRANSP, 0);
    lv_obj_remove_flag(s_zone, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(s_zone, LV_OBJ_FLAG_CLICKABLE);
    g_root=content_group(s_zone);build_guide(g_root);
    m_root=content_group(s_zone);build_main(m_root);
    p_root=content_group(s_zone);build_present(p_root);
    b_root=content_group(s_zone);build_black(b_root);
    build_sheet(s_zone);
    bsp_lvgl_unlock();
}

void pager_page_destroy(void) {
    if(s_zone)lv_obj_delete(s_zone);
    if(s_cover)lv_obj_delete(s_cover);
    s_zone=s_cover=NULL;
    s_flash_deadline=0;
    s_timer_cache=-1;
    s_dirty=true;
}

lv_obj_t *pager_page_zone(void) { return s_zone; }

// —— 装饰与绘制（Piko render() 每 100ms 持锁调用一次）——

void pager_page_decorate(lv_obj_t *title, lv_obj_t *notice, lv_obj_t *hint, bool page_locked)
{
    const bool active=s_locked&&page_locked;
    char peer[PAGER_PEER_NAME_MAX];
    pager_ble_state_t st=ble_snapshot(peer,sizeof(peer));
    if(st==PAGER_BLE_ADVERTISING && s_view!=VIEW_GUIDE){s_view=VIEW_GUIDE;s_present=false;s_sheet=false;s_known_bonds=pager_ble_bond_count();}
    else if(st!=PAGER_BLE_ADVERTISING && s_view==VIEW_GUIDE)s_view=VIEW_MAIN;
    const bool dark=active&&(s_view==VIEW_PRESENT||s_view==VIEW_BLACKOUT);
    const bool sheet_on=active&&s_sheet;
    lv_obj_set_style_bg_color(lv_screen_active(),lv_color_hex(dark?(s_view==VIEW_BLACKOUT?C_BLACK_BG:C_DARK_BG):C_BG),0);
    set_hidden(s_cover,!dark);set_hidden(s_zone,!active);
    set_hidden(g_root,s_view!=VIEW_GUIDE||sheet_on);
    set_hidden(m_root,s_view!=VIEW_MAIN||sheet_on);
    set_hidden(p_root,s_view!=VIEW_PRESENT||sheet_on);
    set_hidden(b_root,s_view!=VIEW_BLACKOUT||sheet_on);
    set_hidden(s_veil,!sheet_on);set_hidden(s_panel,!sheet_on);
    if(sheet_on){
        for(int k=0;k<(int)PAGER_MODE_COUNT;k++){
            bool selected=k==s_sheet_sel;
            lv_obj_set_style_bg_opa(s_row[k],selected?LV_OPA_10:LV_OPA_TRANSP,0);
            set_hidden(s_row_check[k],!selected);
        }
    }
    bool pairing_open=pager_ble_pairing_open();
    if(s_view==VIEW_GUIDE){
        lv_label_set_text(g_big,pairing_open?"新设备配对":"等待连接");
        lv_label_set_text(g_card_txt,!pairing_open&&s_known_bonds>0?
          "连接新设备请打开菜单\n再长按确认键开放配对":TXT_CARD);
        lv_label_set_text(g_legend,pairing_open?"配对窗口持续两分钟":
          s_known_bonds>0?"配对记录保留":"首次配对无需输入配对码");
    }
    bool toast=esp_timer_get_time()<s_flash_deadline;
    set_hidden(m_flash,!toast);set_hidden(m_hint,toast);
    lv_label_set_text(notice,sheet_on?"选择翻页按键":s_view==VIEW_MAIN?"长按上键或下键打开菜单":pairing_open?"新设备配对窗口已开启":"");
    if (s_view == VIEW_MAIN) {
        switch (s_mode) {
        case PAGER_MODE_PAGE:
            lv_obj_set_style_text_font(m_glyphs, F_BIG, 0);
            lv_label_set_text(m_glyphs, "PgUp / PgDn");
            break;
        case PAGER_MODE_VOLUME:
            lv_obj_set_style_text_font(m_glyphs, F_BIG, 0);
            lv_label_set_text(m_glyphs, "音量 + / -");
            break;
        default:
            lv_obj_set_style_text_font(m_glyphs, &lv_font_montserrat_36, 0);
            lv_label_set_text(m_glyphs, LV_SYMBOL_LEFT "  " LV_SYMBOL_RIGHT);
            break;
        }
        lv_label_set_text(m_mode, pager_mode_name(s_mode));
        lv_label_set_text(m_hint, pager_mode_hint(s_mode));
        lv_label_set_text_fmt(m_peer,"%s %s",LV_SYMBOL_BLUETOOTH,
            peer[0]?peer:st==PAGER_BLE_READY?"已连接":"正在连接");
        lv_obj_set_style_text_color(m_peer, lv_color_hex(st == PAGER_BLE_READY ? C_ACC : C_AMBER), 0);
    }


    // 底部键位提示（与其它页面共用 hint_label）
    const char *hint_txt = "";
    if (!page_locked) hint_txt = "短按确认进入 · 上下切页";
    else if (active) {
        if (s_sheet) hint_txt = TXT_SFOOT;
        else if (s_view == VIEW_GUIDE) hint_txt = pairing_open?"请在两分钟内连接新设备\n长按确认键退出翻页":"长按上键或下键打开菜单\n长按确认键退出翻页";
        else if (s_view == VIEW_MAIN) hint_txt = "上下键翻页 · 短按确认放映\n长按确认键退出翻页";
        else if (s_view == VIEW_PRESENT) hint_txt = TXT_PHINT;
        else hint_txt = TXT_WAKE;
    }
    lv_obj_set_size(hint,224,36);
    lv_label_set_long_mode(hint,LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_line_space(hint,2,0);
    lv_obj_align(hint,LV_ALIGN_BOTTOM_MID,0,-35);
    lv_label_set_text(hint, hint_txt);
    lv_obj_set_style_text_color(hint,
        lv_color_hex(dark ? C_DARK_PEEL : C_MUTED), 0);
    lv_obj_set_style_text_color(title, lv_color_hex(dark ? C_BG : C_INK), 0);
    lv_label_set_text(title, "蓝牙翻页器");
    (void)notice;
    s_dirty = false;
}

// —— 动作 ——

static void open_sheet(void)
{
    s_clear_up_at=0;
    s_sheet = true;
    s_sheet_sel = (int)s_mode;
    s_sheet_deadline = esp_timer_get_time() + SHEET_TIMEOUT_US;
}

static void flash(const char *text, uint32_t color)
{
    if (bsp_lvgl_lock(100)) {
        lv_label_set_text(m_flash_txt, text);
        lv_obj_set_style_text_color(m_flash_txt, lv_color_hex(color), 0);
        lv_obj_set_style_border_color(m_flash, lv_color_hex(color), 0);
        lv_obj_remove_flag(m_flash, LV_OBJ_FLAG_HIDDEN);
        bsp_lvgl_unlock();
    }
    s_flash_deadline = esp_timer_get_time() + FLASH_US;
}

static void page(pager_dir_t dir)
{
    char peer[PAGER_PEER_NAME_MAX];
    const pager_ble_state_t st = ble_snapshot(peer, sizeof(peer));
    const bool sent = st == PAGER_BLE_READY && pager_ble_tap(pager_key_for(s_mode, dir));
    flash(sent ? (dir == PAGER_NEXT ? TXT_NEXT : TXT_PREV) : TXT_OFFLINE,
          sent ? C_ACC : C_AMBER);
    ESP_LOGI(TAG, "%s (%s)", dir == PAGER_NEXT ? "next" : "prev", pager_mode_name(s_mode));
}

int pager_page_key(int action, bsp_btn_ev_t event)
{
    (void)event;
    s_last_activity = esp_timer_get_time();
    if (s_dimmed) {
        bsp_display_backlight(BACKLIGHT_NORMAL);
        s_dimmed = false;
    }
    switch (action) {
    case PIKO_PAGER_PREV:
    case PIKO_PAGER_NEXT: {
        const pager_dir_t dir = action == PIKO_PAGER_NEXT ? PAGER_NEXT : PAGER_PREV;
        if (s_sheet) {
            s_sheet_sel += dir == PAGER_NEXT ? 1 : -1;
            s_sheet_sel = s_sheet_sel < 0 ? 0
                          : s_sheet_sel >= (int)PAGER_MODE_COUNT ? (int)PAGER_MODE_COUNT - 1
                                                                 : s_sheet_sel;
            s_sheet_deadline = esp_timer_get_time() + SHEET_TIMEOUT_US;
        } else if (s_view != VIEW_BLACKOUT) {
            page(dir);
        }
        break;
    }
    case PIKO_PAGER_OK:
        if (s_sheet) {
            s_mode = (pager_mode_t)s_sheet_sel;
            mode_save();
            s_sheet = false;
            ESP_LOGI(TAG, "Mode: %s", pager_mode_name(s_mode));
        } else if (s_view == VIEW_BLACKOUT) {
            pager_ble_blackscreen_tap();
            s_view = VIEW_PRESENT;
        } else if (s_view == VIEW_PRESENT) {
            pager_ble_blackscreen_tap();
            s_view = VIEW_BLACKOUT;
        } else if (s_view == VIEW_MAIN) {
            if (pager_ble_state() == PAGER_BLE_READY) {
                pager_ble_slideshow_start();
                s_present = true;
                s_pres_start = esp_timer_get_time();
                s_timer_cache = -1;
                s_view = VIEW_PRESENT;
            } else flash(TXT_OFFLINE, C_AMBER);
        }
        break;
    case PIKO_PAGER_BACK:
        if (s_sheet) {
            pager_ble_open_pairing_window(SHEET_WINDOW_MS);
            s_sheet = false;
            flash(TXT_WINDOW, C_ACC);
        } else if (s_view == VIEW_PRESENT || s_view == VIEW_BLACKOUT) {
            pager_ble_slideshow_exit();
            s_present = false;
            s_view = VIEW_MAIN;
        } else {
            return PIKO_EXIT;  // 主态长按 = 退出页面（对齐设置页"长按返回"）
        }
        break;
    case PIKO_PAGER_HOLD_UP:
    case PIKO_PAGER_HOLD_DOWN:
        if (!s_sheet && (s_view == VIEW_MAIN || s_view == VIEW_GUIDE)) {
            open_sheet();
        } else if (s_sheet) {
            // 抽屉内 上长按→下长按（2 秒内）：清除所有配对
            if (action == PIKO_PAGER_HOLD_UP) {
                s_clear_up_at = esp_timer_get_time();
            } else if (s_clear_up_at && esp_timer_get_time() - s_clear_up_at < CLEAR_COMBO_US) {
                pager_ble_forget_all();
                s_known_bonds=pager_ble_bond_count();
                s_clear_up_at = 0;
                s_sheet = false;
                s_present = false;
                s_view = VIEW_GUIDE;
                flash(TXT_FORGET, C_ACC);
            }
        }
        break;
    }
    s_dirty = true;
    return PIKO_NONE;
}

bool pager_page_open(void)
{
    if(!s_ble_mutex)s_ble_mutex=xSemaphoreCreateMutex();
    if (!s_started) {
        mode_load();
        esp_err_t result=pager_ble_start(DEVICE_NAME,on_ble_state);
        if(result!=ESP_OK){
            ESP_LOGE(TAG,"BLE start failed: %s",esp_err_to_name(result));
            s_locked=false;
            if(s_zone)flash(TXT_OFFLINE,C_AMBER);
            return false;
        }
        s_started = true;
    }
    s_known_bonds=pager_ble_bond_count();
    s_locked = true;
    s_dirty = true;
    ESP_LOGI(TAG, "Pager page open");
    return true;
}

bool pager_page_close(void)
{
    if(s_present){pager_ble_slideshow_exit();s_present=false;}
    {
        esp_err_t result=pager_ble_stop();
        if(result!=ESP_OK){
            ESP_LOGE(TAG,"BLE stop failed: %s",esp_err_to_name(result));
            if(s_zone)flash(TXT_OFFLINE,C_AMBER);
            return false;
        }
        s_started=false;
    }
    s_locked=s_sheet=false;s_clear_up_at=0;
    s_view=VIEW_GUIDE;s_flash_deadline=0;s_timer_cache=-1;
    if(s_dimmed){bsp_display_backlight(BACKLIGHT_NORMAL);s_dimmed=false;}
    s_dirty=true;
    return true;
}

void pager_page_tick(int64_t now_us)
{
    if(!s_zone)return;
    if (s_flash_deadline && now_us > s_flash_deadline) {
        s_flash_deadline = 0;
        if (bsp_lvgl_lock(100)) {
            lv_obj_add_flag(m_flash, LV_OBJ_FLAG_HIDDEN);
            bsp_lvgl_unlock();
        }
    }
    if (s_sheet && now_us > s_sheet_deadline) {
        s_sheet = false;
        s_dirty = true;
    }
    if (s_present && s_view != VIEW_BLACKOUT) {
        const int sec = (int)((now_us - s_pres_start) / 1000000);
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
    if (!s_dimmed && s_locked) {  // 放映 120 秒、其余 60 秒；黑屏本身不调
        const int64_t idle = now_us - s_last_activity;
        if (s_view != VIEW_BLACKOUT &&
            ((s_present && idle > DIM_PRESENT_US) || (!s_present && idle > DIM_MAIN_US))) {
            bsp_display_backlight(s_present ? 6 : BACKLIGHT_DIM);
            s_dimmed = true;
        }
    }
}

void pager_page_set_battery(int percent)
{
    if (s_started) pager_ble_set_battery(percent);
}
