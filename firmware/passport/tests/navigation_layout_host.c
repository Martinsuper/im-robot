#include "lvgl.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
LV_FONT_DECLARE(piko_ui_small);
#define PAGE_COUNT 6
#define PIKO_BG 0xf6f1e7
#define PIKO_MUTED 0x70806d
#define PIKO_ACCENT 0x315e49
static lv_obj_t *nav_bar,*nav_items[3],*nav_dots[PAGE_COUNT];
static int page;
/* static void create_navigation( inserted by runner */
/* static void ui_navigation( inserted by runner */
static uint16_t pixels[240*320];
static void flush(lv_display_t *d,const lv_area_t *a,uint8_t *p){(void)a;(void)p;lv_display_flush_ready(d);}
int main(int argc,char **argv){
 lv_init();
 lv_display_t *d=lv_display_create(240,320);
 lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);
 lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);
 lv_display_set_flush_cb(d,flush);
 lv_obj_t *screen=lv_screen_active();
 lv_obj_set_style_pad_all(screen,0,0);
 lv_obj_set_style_bg_color(screen,lv_color_hex(PIKO_BG),0);
 create_navigation(screen);
 const char *names[]={"语音","Piko","日历","时钟","设置","翻页"};
 for(page=0;page<PAGE_COUNT;page++){
  ui_navigation();lv_obj_update_layout(screen);
  lv_area_t previous={0};
  for(unsigned slot=0;slot<3;slot++){
   lv_obj_t *item=nav_items[slot];lv_area_t a;lv_obj_get_coords(item,&a);
   assert(a.x1>=0&&a.x2<240&&a.y1>=276&&a.y2<320);
   if(slot)assert(previous.x2<a.x1);
   previous=a;
   assert(strcmp(lv_label_get_text(item),names[(page+PAGE_COUNT+slot-1)%PAGE_COUNT])==0);
   lv_point_t size;lv_text_get_size(&size,lv_label_get_text(item),&piko_ui_small,0,0,240,LV_TEXT_FLAG_NONE);
   assert(size.x<=lv_obj_get_content_width(item)&&size.y<=lv_obj_get_content_height(item));
  }
  for(int k=0;k<PAGE_COUNT;k++){
   lv_area_t a;lv_obj_get_coords(nav_dots[k],&a);assert(a.x1>=0&&a.x2<240&&a.y1>previous.y2&&a.y2<320);
   assert(lv_obj_get_style_bg_opa(nav_dots[k],0)==(k==page?LV_OPA_COVER:LV_OPA_20));
  }
 }
 page=0;ui_navigation();lv_refr_now(d);
 FILE *f=fopen(argc>1?argv[1]:"navigation.ppm","wb");assert(f);fprintf(f,"P6\n240 320\n255\n");
 for(int i=0;i<240*320;i++){uint16_t v=pixels[i];uint8_t rgb[]={((v>>11)&31)*255/31,((v>>5)&63)*255/63,(v&31)*255/31};fwrite(rgb,1,3,f);}fclose(f);
 puts("PASS: all six pages, wrapped neighbors, text fits, no clipping/overlap, correct position dots");
}
