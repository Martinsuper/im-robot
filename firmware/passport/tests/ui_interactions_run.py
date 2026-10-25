#!/usr/bin/env python3
"""Compile actual locked-page handlers against deterministic device/NVS stubs."""
from pathlib import Path
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'main/main.c').read_text()
def function(name,kind='void'):
    a=source.index(f'static {kind} {name}(')
    return source[a:source.index('\n}',a)+2]
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include "ui_controls.h"
#include "piko_clock.h"
#include "ui_input.h"
#include "confirmation_gate.h"
#define ESP_OK 0
#define PAGE_COUNT 6
#define NVS_READWRITE 1
#define portMAX_DELAY 0
typedef int esp_err_t;
typedef int nvs_handle_t;
typedef enum {BSP_BTN_OK,BSP_BTN_UP,BSP_BTN_DOWN} bsp_btn_t;
typedef enum {BSP_BTN_PRESS,BSP_BTN_RELEASE,BSP_BTN_CLICK,BSP_BTN_LONG,BSP_BTN_DOUBLE} bsp_btn_ev_t;
typedef struct {bsp_btn_t key;bsp_btn_ev_t event;uint32_t confirmation_epoch;} key_event_t;
enum {PAGE_INPUT,PAGE_PIKO,PAGE_CALENDAR,PAGE_CLOCK,PAGE_SETTINGS,PAGE_PAGER};
enum {VIEW_MAIN,VIEW_LINK,VIEW_REPRO};
static int page=PAGE_PIKO,mutex;
static unsigned chat_session_sequence;
static int64_t chat_session_started;
static char chat_session[65],boot_id[]="boot-test";
static bool page_locked,audio_ready=true,audio_start_failed;
static uint8_t settings_view,menu_selected,volume_level=2;
static const uint8_t volume_percent[]={0,25,50,75,100};
static atomic_bool input_selected,volume_controls;
static atomic_uint link_mode=1;
static int volume_direction,cal_direction;
__attribute__((unused)) static int cal_year,cal_month,cal_day;
static bool volume_click_suppressed,input_down_long,cal_click_suppressed;
static uint8_t cal_view;
static int64_t cal_repeat_at;
static uint8_t clk_bright=3,clk_idle_mode=1,clk_menu_open,clk_menu_row,clk_screen_off;
static bool clk_click_suppressed,clk_wake_suppress,pager_start_failed;
static atomic_bool desktop_suspended,desktop_pause_ready=true;
#define pdMS_TO_TICKS(x) (x)
static void vTaskDelay(unsigned ms){(void)ms;}
static int64_t clk_activity_at;
static int clk_direction;
static int64_t clk_repeat_at,clk_bright_until;
static int clk_brightness_applied;
static void clk_apply_brightness(void);
static bool clk_save(void){return true;}
static bool pager_open_ok=true;
static bool pager_page_open(void){return pager_open_ok;}
static bool pager_close_ok=true;
static bool pager_page_close(void){return pager_close_ok;}
static bool pager_exit_requested;
static int pager_page_key(int action,bsp_btn_ev_t event){(void)action;(void)event;return pager_exit_requested?PIKO_EXIT:PIKO_NONE;}
static int cal_step_calls,cal_toggles,cal_enters;
static void cal_step(int d){(void)d;cal_step_calls++;}
static void cal_enter_today(void){cal_view=0;cal_enters++;}
static void cal_toggle(void){cal_view^=1;cal_toggles++;}
static bool screen_off;
enum { SCREEN_BACKLIGHT_PERCENT = 65 };
static int backlight=65;
static void bsp_display_backlight(int value){backlight=value;}
static void clk_apply_brightness(void){
 static const int pct[]={5,25,50,75,100};
 clk_brightness_applied=clk_bright;backlight=screen_off||clk_screen_off?0:pct[clk_bright];
}
static int64_t now,volume_repeat_at,volume_notice_until,settings_error_until;
static bool link_confirm,link_confirm_fresh,voice_stop_requested;
static unsigned text_page_index,text_page_count=1;
static piko_voice_key_t voice_key;
static struct {bool voice_busy;char voice_stage[24];piko_confirmation_gate_t confirmation_gate;} model;
static struct {char token[65];} cfg;
static int cancelled,approved,input_press,input_release,input_enter,stopped,mode_changed=-1,reconfigured;
static bool selectable=true,open_ok=true,set_ok=true,commit_ok=true;
static int volume_applied=-1;
static int64_t esp_timer_get_time(void){return now;}
static void xSemaphoreTake(int a,int b){(void)a;(void)b;}
static void xSemaphoreGive(int a){(void)a;}
static void copy_text(char *d,size_t n,const char *s){snprintf(d,n,"%s",s);}
static int nvs_open(const char *name,int mode,int *h){(void)name;(void)mode;*h=1;return open_ok?0:1;}
static int nvs_set_u8(int h,const char *key,uint8_t v){(void)h;assert(!strcmp(key,"volume5"));assert(v<=4);return set_ok?0:1;}
static int nvs_commit(int h){(void)h;return commit_ok?0:1;}
static void nvs_close(int h){(void)h;}
static void bsp_audio_set_volume(int v){volume_applied=v;}
static void change_link(unsigned mode){mode_changed=mode;}
static void setup_on_next_boot(void){reconfigured++;}
static bool audio_init_ok=true,audio_deinit_ok=true;
static int passport_audio_init(void){return audio_init_ok?0:1;}
static int passport_audio_deinit(void){return audio_deinit_ok?0:1;}
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
static void passport_audio_stop_record(void){stopped++;}
static bool voice_input_select(void){return selectable;}
static void voice_input_open(void){}
static void voice_input_close(void){}
static void voice_input_press(void){input_press++;}
static void voice_input_release(void){input_release++;}
static void voice_input_enter_key(void){input_enter++;}
static void voice_cancel(void){cancelled++;model.voice_busy=false;strcpy(model.voice_stage,"cancelled");}
static void voice_decide(bool allowed){assert(allowed);if(piko_confirmation_consume(&model.confirmation_gate))approved++;}
FUNCTIONS
static void key(bsp_btn_t k,bsp_btn_ev_t e){handle_key((key_event_t){k,e,model.confirmation_gate.epoch},true);}
int main(void){
  for(int p=0;p<PAGE_COUNT;p++)for(unsigned locked=0;locked<2;locked++){
    page=p;page_locked=locked;
    for(unsigned toggle=0;toggle<2;toggle++){
      for(unsigned tap=0;tap<2;tap++){
        key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_RELEASE);
      }
      key(BSP_BTN_OK,BSP_BTN_DOUBLE);
      assert(screen_off==(toggle==0) && backlight==(toggle==0?0:(p==PAGE_CLOCK&&locked?75:65)));
      assert(page==p && page_locked==locked);
      assert(!cancelled && !approved && !input_enter && !cal_toggles);
    }
  }
  key(BSP_BTN_UP,BSP_BTN_DOUBLE);assert(!screen_off);
  page=PAGE_PIKO;page_locked=false;
  // Existing recording/input/approval checks also run with the screen off.
  screen_off=true;backlight=0;

  assert(!piko_pages_complete(0,1));assert(piko_pages_complete(1,1));
  assert(!piko_pages_complete(7,4));assert(piko_pages_complete(15,4));
  assert(piko_pages_complete(UINT64_MAX,64));assert(!piko_pages_complete(UINT64_MAX,65));

  assert(piko_confirmation_holds_status(true,"thinking"));
  assert(piko_confirmation_holds_status(true,"working"));
  assert(!piko_confirmation_holds_status(true,"done"));
  assert(!piko_confirmation_holds_status(false,"working"));
  // Browsing cannot record or change volume; short OK explicitly enters.
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(!page_locked && !voice_key.held);
  key(BSP_BTN_UP,BSP_BTN_LONG);assert(volume_level==2);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked && atomic_load(&volume_controls));
  assert(!strcmp(chat_session,"boot-test-chat-1"));
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page==PAGE_PIKO);
  key(BSP_BTN_OK,BSP_BTN_PRESS);now=300001;assert(piko_voice_key_tick(&voice_key,now));
  model.voice_busy=true;strcpy(model.voice_stage,"listening");
  key(BSP_BTN_UP,BSP_BTN_LONG);assert(volume_level==2);
  key(BSP_BTN_OK,BSP_BTN_RELEASE);assert(stopped==1 && voice_stop_requested);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked && !cancelled); // release-click suppressed
  strcpy(model.voice_stage,"thinking");
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_RELEASE);key(BSP_BTN_OK,BSP_BTN_CLICK);
  assert(!page_locked && cancelled==1);
  assert(chat_session_sequence==1);
  // Some drivers emit no click after a long recording; next fresh press still exits.
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(chat_session_sequence==2);voice_key.suppress_click=true;model.voice_busy=true;
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked && cancelled==2);
  // Five volume levels, clamps and NVS rollback on every failure mode.
  key(BSP_BTN_OK,BSP_BTN_CLICK);
  key(BSP_BTN_UP,BSP_BTN_LONG);assert(volume_level==3 && volume_applied==75);
  key(BSP_BTN_UP,BSP_BTN_RELEASE);assert(!volume_direction);
  open_ok=false;adjust_volume(true);assert(volume_level==3 && settings_error_until>now);
  open_ok=true;set_ok=false;adjust_volume(false);assert(volume_level==3);
  set_ok=true;commit_ok=false;adjust_volume(false);assert(volume_level==3);
  commit_ok=true;for(int i=0;i<10;i++)adjust_volume(false);assert(volume_level==0 && volume_applied==0);
  for(int i=0;i<10;i++)adjust_volume(true);assert(volume_level==4 && volume_applied==100);
  // Read text with UP/DOWN; OK exits even during playback.
  model.voice_busy=true;strcpy(model.voice_stage,"playing");text_page_count=8;text_page_index=3;
  key(BSP_BTN_DOWN,BSP_BTN_PRESS);key(BSP_BTN_DOWN,BSP_BTN_RELEASE);key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(text_page_index==4);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(text_page_index==3);
  // Approval requires all content shown and a fresh press; short OK never approves.
  strcpy(model.voice_stage,"awaiting_confirmation");piko_confirmation_new(&model.confirmation_gate,1,false);
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_LONG);assert(!approved);
  piko_confirmation_show(&model.confirmation_gate,1);
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(!approved);
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_LONG);assert(approved==1);
  piko_confirmation_new(&model.confirmation_gate,2,true);piko_confirmation_show(&model.confirmation_gate,2);
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_LONG);assert(approved==1);
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked);
  // Input mode never sends Enter on completion/release or a long DOWN press.
  page=PAGE_INPUT;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);assert(input_press==1 && input_release==1 && !input_enter);
  key(BSP_BTN_DOWN,BSP_BTN_PRESS);key(BSP_BTN_DOWN,BSP_BTN_LONG);key(BSP_BTN_DOWN,BSP_BTN_RELEASE);key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(!input_enter);
  key(BSP_BTN_DOWN,BSP_BTN_PRESS);key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(input_enter==1);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked);
  // Only two settings. Connection never has a manual start/stop switch.
  page=PAGE_SETTINGS;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked);
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(menu_selected==1);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(settings_view==VIEW_LINK);
  strcpy(cfg.token,"paired");key(BSP_BTN_OK,BSP_BTN_CLICK);assert(link_confirm);
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(mode_changed==-1);
  key(BSP_BTN_OK,BSP_BTN_PRESS);key(BSP_BTN_OK,BSP_BTN_LONG);assert(mode_changed==2);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!link_confirm);
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(settings_view==VIEW_MAIN);
  key(BSP_BTN_UP,BSP_BTN_CLICK);assert(!menu_selected);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(settings_view==VIEW_REPRO);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(settings_view==VIEW_MAIN && !reconfigured);
  key(BSP_BTN_OK,BSP_BTN_CLICK);key(BSP_BTN_OK,BSP_BTN_LONG);assert(reconfigured==1);
  settings_view=VIEW_MAIN;key(BSP_BTN_OK,BSP_BTN_LONG);assert(!page_locked);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(page==PAGE_CLOCK);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(page==PAGE_CALENDAR);
  // Calendar: enter resets to today, long UP steps once, long click suppressed, OK toggles, long OK exits.
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked && cal_enters==1);
  key(BSP_BTN_UP,BSP_BTN_LONG);assert(cal_step_calls==1 && cal_click_suppressed);
  key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(cal_step_calls==1);
  key(BSP_BTN_DOWN,BSP_BTN_PRESS);key(BSP_BTN_DOWN,BSP_BTN_RELEASE);key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(cal_step_calls==2);
  // CLICK arrives after RELEASE: single step must not arm the repeat timer.
  assert(!cal_direction);
  key(BSP_BTN_DOWN,BSP_BTN_LONG);assert(cal_step_calls==3 && cal_direction==1);
  key(BSP_BTN_DOWN,BSP_BTN_RELEASE);assert(!cal_direction);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(cal_toggles==1);
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(!page_locked);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(page==PAGE_PIKO);
  // Clock: short press = one brightness step, LONG arms hold-repeat, OK toggles menu, long OK exits.
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page==PAGE_CALENDAR);
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page==PAGE_CLOCK);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked && !clk_menu_open);
  key(BSP_BTN_UP,BSP_BTN_CLICK);assert(clk_bright==4 && clk_brightness_applied==4);
  key(BSP_BTN_UP,BSP_BTN_CLICK);assert(clk_bright==4);
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(clk_bright==3);
  key(BSP_BTN_UP,BSP_BTN_LONG);assert(clk_direction==1 && clk_click_suppressed);
  key(BSP_BTN_UP,BSP_BTN_RELEASE);assert(!clk_direction);
  key(BSP_BTN_UP,BSP_BTN_CLICK);assert(clk_bright==4);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(clk_menu_open);
  key(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(clk_menu_row==1);
  key(BSP_BTN_OK,BSP_BTN_CLICK);assert(clk_bright==4);
  key(BSP_BTN_OK,BSP_BTN_LONG);assert(!page_locked && !clk_menu_open);
  key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(page==PAGE_CALENDAR);
  key(BSP_BTN_UP,BSP_BTN_CLICK);assert(page==PAGE_PIKO);
  assert(screen_off && backlight==0);
  // Waking consumes the full gesture and restarts the app idle clock.
 page=PAGE_CLOCK;page_locked=true;screen_off=false;clk_screen_off=1;clk_bright=2;
 int64_t before_wake=clk_activity_at;
 key(BSP_BTN_UP,BSP_BTN_PRESS);assert(!clk_screen_off&&clk_wake_suppress&&clk_bright==2);
 key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);assert(clk_bright==2);
 key(BSP_BTN_OK,BSP_BTN_DOUBLE);assert(!screen_off);
 key(BSP_BTN_UP,BSP_BTN_PRESS);key(BSP_BTN_UP,BSP_BTN_RELEASE);key(BSP_BTN_UP,BSP_BTN_CLICK);
 assert(clk_bright==3&&!clk_wake_suppress&&clk_activity_at>=before_wake);
 // A failed BLE init must not lock the user into a nonfunctional page.
 page=PAGE_PAGER;page_locked=false;pager_open_ok=false;
 key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked&&pager_start_failed);
 pager_open_ok=true;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked&&!pager_start_failed);
 // Audio is acquired only for a selected voice mode, with rollback on failure.
 page=PAGE_INPUT;page_locked=false;audio_ready=false;audio_init_ok=false;
 key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked&&!audio_ready&&audio_start_failed);
 audio_init_ok=true;selectable=false;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked&&!audio_ready);
 selectable=true;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked&&audio_ready);
 audio_deinit_ok=false;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked&&!audio_ready);
 audio_deinit_ok=true;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked&&!audio_ready);
 page=PAGE_PAGER;page_locked=false;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked&&!audio_ready&&atomic_load(&volume_controls));
 pager_exit_requested=true;pager_close_ok=false;key(BSP_BTN_OK,BSP_BTN_LONG);assert(page_locked);
 pager_close_ok=true;key(BSP_BTN_OK,BSP_BTN_LONG);assert(!page_locked&&!atomic_load(&volume_controls));
 page=PAGE_PIKO;key(BSP_BTN_OK,BSP_BTN_CLICK);assert(page_locked&&audio_ready);
 key(BSP_BTN_OK,BSP_BTN_CLICK);assert(!page_locked&&!audio_ready);
 puts("PASS: locked pages, recording release, manual Enter only, volume/mute rollback, two settings and fresh hold-to-approve");
}
'''.replace('FUNCTIONS','\n'.join(function(n,k) for n,k in [('settings_save','bool'),('apply_volume','void'),('audio_mode_acquire','bool'),('audio_mode_release','bool'),('adjust_volume','void'),('settings_key','void'),('handle_key','void')]))
with tempfile.TemporaryDirectory(prefix='piko-controls-') as temp:
    path=Path(temp)/'test.c';path.write_text(harness);binary=Path(temp)/'test'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',f'-I{root / "main"}',str(path),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=10)
