#include "pager_keys.h"

// HID Usage Tables 1.4: Keyboard page 0x07, Consumer page 0x0C.
#define KEY_RIGHT     0x4F
#define KEY_LEFT      0x50
#define KEY_PAGE_UP   0x4B
#define KEY_PAGE_DOWN 0x4E
#define CC_VOLUME_UP   0xE9
#define CC_VOLUME_DOWN 0xEA

pager_key_t pager_key_for(pager_mode_t mode, pager_dir_t dir)
{
    const bool next = dir == PAGER_NEXT;
    switch (mode) {
    case PAGER_MODE_PAGE:
        return (pager_key_t){PAGER_RPT_KEYBOARD, next ? KEY_PAGE_DOWN : KEY_PAGE_UP, 0};
    case PAGER_MODE_VOLUME:
        // 文石的音量键翻页：音量减 = 下一页。
        return (pager_key_t){PAGER_RPT_CONSUMER, next ? CC_VOLUME_DOWN : CC_VOLUME_UP, 0};
    case PAGER_MODE_ARROW:
    default:
        return (pager_key_t){PAGER_RPT_KEYBOARD, next ? KEY_RIGHT : KEY_LEFT, 0};
    }
}

const char *pager_mode_name(pager_mode_t mode)
{
    static const char *names[PAGER_MODE_COUNT] = {"方向键", "翻页键", "音量键"};
    return mode < PAGER_MODE_COUNT ? names[mode] : "?";
}

// 单行说明：主界面 hero 的副标和模式抽屉里的选项副标共用。字库里没有间隔号 ·，用逗号分隔。
const char *pager_mode_hint(pager_mode_t mode)
{
    static const char *hints[PAGER_MODE_COUNT] = {
        "左右方向键，Keynote、PowerPoint",
        "PageUp / PageDown，PPT、网页",
        "音量加 / 减，文石需开音量键翻页",
    };
    return mode < PAGER_MODE_COUNT ? hints[mode] : "";
}

pager_mode_t pager_next_mode(pager_mode_t mode)
{
    return (pager_mode_t)((mode + 1) % PAGER_MODE_COUNT);
}
