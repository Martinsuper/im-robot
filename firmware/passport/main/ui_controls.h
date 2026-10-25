#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum { PIKO_INPUT, PIKO_CHAT, PIKO_CALENDAR, PIKO_CLOCK, PIKO_SETTINGS, PIKO_PAGER };
enum { PIKO_OK, PIKO_UP, PIKO_DOWN };
enum { PIKO_PRESS, PIKO_RELEASE, PIKO_CLICK, PIKO_LONG };
enum { PIKO_NONE, PIKO_ENTER, PIKO_EXIT, PIKO_PREV_PAGE, PIKO_NEXT_PAGE,
       PIKO_RECORD_PRESS, PIKO_RECORD_RELEASE, PIKO_TEXT_PREV, PIKO_TEXT_NEXT,
       PIKO_VOLUME_UP, PIKO_VOLUME_DOWN, PIKO_APPROVAL_PRESS, PIKO_APPROVE,
       PIKO_INPUT_PRESS, PIKO_INPUT_RELEASE, PIKO_INPUT_ENTER,
       PIKO_MENU_PREV, PIKO_MENU_NEXT, PIKO_MENU_SELECT, PIKO_MENU_BACK,
       PIKO_CAL_PREV, PIKO_CAL_NEXT, PIKO_CAL_TOGGLE,
       PIKO_CLK_UP, PIKO_CLK_DOWN, PIKO_CLK_MENU,
       PIKO_PAGER_PREV, PIKO_PAGER_NEXT, PIKO_PAGER_OK, PIKO_PAGER_BACK,
       PIKO_PAGER_HOLD_UP, PIKO_PAGER_HOLD_DOWN };

static inline bool piko_volume_allowed(bool busy,const char *stage) {
  return !busy || strcmp(stage,"playing")==0;
}
static inline unsigned piko_volume_step(unsigned level,bool up) {
  return up?(level<4?level+1:4):(level?level-1:0);
}
static inline unsigned piko_menu_step(unsigned selected,bool up) {
  (void)up;
  return (selected+1)%2;
}
/* Pure routing policy shared by firmware and host regression tests. */
static inline int piko_control(unsigned page,bool locked,unsigned key,unsigned event,
                               bool busy,const char *stage) {
  if(!locked){
    if(event!=PIKO_CLICK)return PIKO_NONE;
    return key==PIKO_OK?PIKO_ENTER:key==PIKO_UP?PIKO_PREV_PAGE:PIKO_NEXT_PAGE;
  }
  if(page==PIKO_PAGER){
    if(key==PIKO_OK)return event==PIKO_CLICK?PIKO_PAGER_OK:event==PIKO_LONG?PIKO_PAGER_BACK:PIKO_NONE;
    if(event==PIKO_PRESS)return key==PIKO_UP?PIKO_PAGER_PREV:PIKO_PAGER_NEXT;
    if(event==PIKO_LONG)return key==PIKO_UP?PIKO_PAGER_HOLD_UP:PIKO_PAGER_HOLD_DOWN;
    return PIKO_NONE;
  }
  if(page==PIKO_SETTINGS){
    if(key==PIKO_OK)return event==PIKO_CLICK?PIKO_MENU_SELECT:event==PIKO_LONG?PIKO_MENU_BACK:PIKO_NONE;
    if(event==PIKO_CLICK)return key==PIKO_UP?PIKO_MENU_PREV:PIKO_MENU_NEXT;
    return PIKO_NONE;
  }
  if(page==PIKO_INPUT){
    if(key==PIKO_OK)return event==PIKO_CLICK?PIKO_EXIT:PIKO_NONE;
    if(key==PIKO_UP)return event==PIKO_PRESS?PIKO_INPUT_PRESS:event==PIKO_RELEASE?PIKO_INPUT_RELEASE:PIKO_NONE;
    return event==PIKO_CLICK?PIKO_INPUT_ENTER:PIKO_NONE;
  }
  if(page==PIKO_CALENDAR){
    if(key==PIKO_OK)return event==PIKO_CLICK?PIKO_CAL_TOGGLE:event==PIKO_LONG?PIKO_EXIT:PIKO_NONE;
    if(event==PIKO_CLICK||event==PIKO_LONG)return key==PIKO_UP?PIKO_CAL_PREV:PIKO_CAL_NEXT;
    return PIKO_NONE;
  }
  if(page==PIKO_CLOCK){
    if(key==PIKO_OK)return event==PIKO_CLICK?PIKO_CLK_MENU:event==PIKO_LONG?PIKO_EXIT:PIKO_NONE;
    if(event==PIKO_CLICK||event==PIKO_LONG)return key==PIKO_UP?PIKO_CLK_UP:PIKO_CLK_DOWN;
    return PIKO_NONE;
  }
  bool approval=strcmp(stage,"awaiting_confirmation")==0;
  if(key==PIKO_OK){
    if(event==PIKO_CLICK)return PIKO_EXIT;
    if(approval)return event==PIKO_PRESS?PIKO_APPROVAL_PRESS:event==PIKO_LONG?PIKO_APPROVE:PIKO_NONE;
    if(!busy && event==PIKO_PRESS)return PIKO_RECORD_PRESS;
    if(event==PIKO_RELEASE)return PIKO_RECORD_RELEASE;
    return PIKO_NONE;
  }
  if(event==PIKO_LONG && piko_volume_allowed(busy,stage))
    return key==PIKO_UP?PIKO_VOLUME_UP:PIKO_VOLUME_DOWN;
  if(event==PIKO_CLICK)return key==PIKO_UP?PIKO_TEXT_PREV:PIKO_TEXT_NEXT;
  return PIKO_NONE;
}

static inline bool piko_pages_complete(uint64_t seen,unsigned count) {
  return count && count<=64 && seen==(count==64?UINT64_MAX:(UINT64_C(1)<<count)-1);
}
