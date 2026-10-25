#!/usr/bin/env python3
"""Exercise production view ownership across repeated transitions."""
from pathlib import Path
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'main/main.c').read_text()
def function(signature):
    a=source.index(signature)
    b=source.index('\n}',a)+2
    return source[a:b]
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
typedef struct {bool live;} lv_obj_t;
enum {UI_MIC,UI_MIN,UI_CARD,UI_MENU,UI_CAL,UI_CLK,UI_PAGER,UI_NONE};
static lv_obj_t *zone_mic,*zone_min,*zone_card,*zone_menu,*zone_cal,*zone_clk;
static lv_obj_t chrome,*title=&chrome,*notice=&chrome,*hint_label=&chrome,*nav_bar=&chrome;
static lv_obj_t *pager;
static unsigned live,created,deleted;
static bool anim;
#define PIKO_BG 0
#define PIKO_INK 0
#define PIKO_MUTED 0
#define ESP_LOGI(...) ((void)0)
#define LV_SIZE_CONTENT 0
#define LV_LABEL_LONG_MODE_WRAP 0
#define LV_ALIGN_BOTTOM_MID 0
static void lv_obj_set_size(lv_obj_t *o,int w,int h){assert(o);(void)w;(void)h;}
static void lv_label_set_long_mode(lv_obj_t *o,int m){assert(o);(void)m;}
static void lv_obj_set_style_text_line_space(lv_obj_t *o,int s,int p){assert(o);(void)s;(void)p;}
static void lv_obj_align(lv_obj_t *o,int a,int x,int y){assert(o);(void)a;(void)x;(void)y;}
static int lv_color_hex(int n){return n;}
static lv_obj_t *lv_screen_active(void){return &chrome;}
static void lv_obj_set_style_bg_color(lv_obj_t *o,int c,int p){(void)c;(void)p;assert(o);}
static void lv_obj_set_style_text_color(lv_obj_t *o,int c,int p){(void)c;(void)p;assert(o);}
static void lv_obj_move_to_index(lv_obj_t *o,int i){(void)i;assert(o==hint_label||o==nav_bar);}
static void lv_obj_set_hidden(lv_obj_t *o,bool b){assert(o&&o->live&&!b);}
static void mic_anim_pause(void){anim=false;}
static void lv_obj_delete(lv_obj_t *o){assert(o&&o!=&chrome&&o->live&&!anim);o->live=false;live--;deleted++;free(o);}
static lv_obj_t *new_view(void){lv_obj_t *o=malloc(sizeof(*o));assert(o);o->live=true;live++;created++;return o;}
#define CREATOR(name) static void create_##name(void){name=new_view();}
CREATOR(zone_mic) CREATOR(zone_min) CREATOR(zone_card) CREATOR(zone_menu) CREATOR(zone_cal) CREATOR(zone_clk)
static void pager_page_build(lv_obj_t *screen){assert(screen==&chrome&&!pager);pager=new_view();}
static void pager_page_destroy(void){assert(pager);lv_obj_delete(pager);pager=NULL;}
FUNCTIONS
int main(void){
 for(unsigned pass=0;pass<100;pass++){
  for(unsigned kind=0;kind<UI_NONE;kind++){
   show_zone(kind);assert(live==1);
   unsigned before=created;show_zone(kind);assert(created==before);
   for(unsigned other=0;other<UI_PAGER;other++)assert((*zone_slot(other)!=NULL)==(other==kind));
   if(kind==UI_MIC)anim=true;
  }
 }
 assert(created==700&&deleted==699&&live==1);
 puts("PASS: 700 view transitions, one live view, animation cancelled before deletion, chrome retained, pager released");
}
'''.replace('FUNCTIONS','\n'.join(function(s) for s in ['static lv_obj_t **zone_slot(', 'static void show_zone(unsigned kind) {']))
with tempfile.TemporaryDirectory(prefix='piko-ui-lifecycle-') as temp:
    path=Path(temp)/'test.c';path.write_text(harness);binary=Path(temp)/'test'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address',str(path),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=10)
