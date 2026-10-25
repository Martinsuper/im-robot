#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include "pager_page.c"
int64_t pager_layout_now=3000000;
esp_err_t pager_ble_start(const char*n,pager_ble_state_cb_t cb){(void)n;cb(PAGER_BLE_ADVERTISING,"");return ESP_OK;}
esp_err_t pager_ble_stop(void){return ESP_OK;}
pager_ble_state_t pager_ble_state(void){return s_ble;}
bool pager_ble_tap(pager_key_t key){(void)key;return true;}
void pager_ble_set_battery(int p){(void)p;}
void pager_ble_forget_all(void){}
void pager_ble_slideshow_start(void){}
void pager_ble_slideshow_exit(void){}
void pager_ble_blackscreen_tap(void){}
static bool pairing_window;
void pager_ble_open_pairing_window(uint32_t ms){assert(ms==120000);pairing_window=true;}
bool pager_ble_pairing_open(void){return pairing_window;}
int pager_ble_bond_count(void){return 1;}
static uint16_t pixels[240*320];
static lv_obj_t *title,*notice,*hint,*nav;
static void flush(lv_display_t*d,const lv_area_t*a,uint8_t*p){(void)a;(void)p;lv_display_flush_ready(d);}
static lv_obj_t *chrome_label(const char*text,const lv_font_t*f,int y){
 lv_obj_t*o=lv_label_create(lv_screen_active());lv_label_set_text(o,text);
 lv_obj_set_width(o,220);lv_obj_set_style_text_align(o,LV_TEXT_ALIGN_CENTER,0);
 lv_obj_set_style_text_font(o,f,0);lv_obj_set_style_text_color(o,lv_color_hex(C_INK),0);
 lv_obj_align(o,LV_ALIGN_TOP_MID,0,y);return o;
}
static unsigned collect(lv_obj_t*o,lv_obj_t**labels,unsigned count){
 if(!lv_obj_is_visible(o))return count;
 if(lv_obj_check_type(o,&lv_label_class)){assert(count<64);labels[count++]=o;}
 for(unsigned i=0;i<lv_obj_get_child_count(o);i++)count=collect(lv_obj_get_child(o,i),labels,count);
 return count;
}
static void check_bounds(const char*name){
 lv_obj_update_layout(lv_screen_active());
 lv_point_t footer_text;
 lv_text_get_size(&footer_text,lv_label_get_text(hint),lv_obj_get_style_text_font(hint,0),0,
   lv_obj_get_style_text_line_space(hint,0),lv_obj_get_content_width(hint),(lv_text_flag_t)0);
 assert(footer_text.y<=lv_obj_get_content_height(hint));
 lv_area_t footer_area,zone_area,nav_area;
 lv_obj_get_coords(hint,&footer_area);lv_obj_get_coords(s_zone,&zone_area);lv_obj_get_coords(nav,&nav_area);
 assert(footer_area.y1>zone_area.y2&&footer_area.y2<nav_area.y1);
 assert(strstr(lv_label_get_text(hint),"确认")!=NULL);
lv_obj_t*labels[64];unsigned count=collect(s_zone,labels,0);
 assert(count>0);
 for(unsigned i=0;i<count;i++){
  lv_area_t a,parent;lv_obj_get_coords(labels[i],&a);lv_obj_get_content_coords(lv_obj_get_parent(labels[i]),&parent);
  if(!(a.x1>=parent.x1&&a.x2<=parent.x2&&a.y1>=parent.y1&&a.y2<=parent.y2)){
   fprintf(stderr,"%s outside parent: %s [%d,%d..%d,%d] parent [%d,%d..%d,%d]\n",name,lv_label_get_text(labels[i]),a.x1,a.y1,a.x2,a.y2,parent.x1,parent.y1,parent.x2,parent.y2);abort();
  }
  if(lv_label_get_long_mode(labels[i])==LV_LABEL_LONG_MODE_WRAP){
   lv_point_t text_size;
   lv_text_get_size(&text_size,lv_label_get_text(labels[i]),lv_obj_get_style_text_font(labels[i],0),
      lv_obj_get_style_text_letter_space(labels[i],0),lv_obj_get_style_text_line_space(labels[i],0),
      lv_obj_get_content_width(labels[i]),(lv_text_flag_t)0);
   if(text_size.y>lv_obj_get_content_height(labels[i])){
    fprintf(stderr,"%s clipped text: %s height=%d available=%d\n",name,lv_label_get_text(labels[i]),(int)text_size.y,(int)lv_obj_get_content_height(labels[i]));abort();
   }
  }
  for(unsigned j=0;j<i;j++){
   lv_area_t b;lv_obj_get_coords(labels[j],&b);
   if(a.x1<=b.x2&&b.x1<=a.x2&&a.y1<=b.y2&&b.y1<=a.y2){
    fprintf(stderr,"%s overlap: %s / %s\n",name,lv_label_get_text(labels[i]),lv_label_get_text(labels[j]));abort();
   }
  }
 }
 unsigned visible=lv_obj_is_visible(g_root)+lv_obj_is_visible(m_root)+lv_obj_is_visible(p_root)+lv_obj_is_visible(b_root);
 assert(visible==(s_sheet?0:1));
 printf("PASS %s: %u visible labels, no overlap or overflow\n",name,count);
}
static void capture(lv_display_t*d,const char*dir,const char*name){
 pager_page_decorate(title,notice,hint,true);lv_obj_move_to_index(hint,-1);lv_obj_move_to_index(nav,-1);
 check_bounds(name);lv_obj_invalidate(lv_screen_active());lv_refr_now(d);char path[1024];snprintf(path,sizeof(path),"%s/%s.ppm",dir,name);
 FILE*f=fopen(path,"wb");assert(f);fprintf(f,"P6\n240 320\n255\n");
 for(unsigned i=0;i<240*320;i++){uint16_t v=pixels[i];uint8_t c[]={((v>>11)&31)*255/31,((v>>5)&63)*255/63,(v&31)*255/31};fwrite(c,1,3,f);}fclose(f);
}
int main(int argc,char**argv){
 assert(argc==2);lv_init();lv_display_t*d=lv_display_create(240,320);
 lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(d,flush);
 lv_obj_set_style_bg_color(lv_screen_active(),lv_color_hex(C_BG),0);
 title=chrome_label("蓝牙翻页器",&piko_ui_title,26);notice=chrome_label("",&piko_ui_small,56);
 hint=chrome_label("",&piko_ui_small,255);nav=chrome_label("语音  Piko  日历  时钟  设置  翻页",&piko_ui_small,286);
 pager_page_build(lv_screen_active());assert(g_root&&m_root&&p_root&&b_root&&p_live);
 lv_font_glyph_dsc_t icon;
 assert(lv_font_get_glyph_dsc(F_SMALL,&icon,0xf00c,0)&&!icon.is_placeholder);
 assert(lv_font_get_glyph_dsc(F_SMALL,&icon,0xf053,0)&&!icon.is_placeholder);
 s_locked=true;on_ble_state(PAGER_BLE_ADVERTISING,"");s_view=VIEW_GUIDE;capture(d,argv[1],"guide");
 s_known_bonds=1;capture(d,argv[1],"guide-bonded");
 for(unsigned tick=0;tick<20;tick++){pager_page_decorate(title,notice,hint,true);assert(s_view==VIEW_GUIDE&&!s_sheet);}
 pager_page_key(PIKO_PAGER_HOLD_UP,BSP_BTN_LONG);assert(s_sheet);capture(d,argv[1],"guide-sheet");
 for(unsigned tick=0;tick<20;tick++){pager_page_decorate(title,notice,hint,true);assert(s_view==VIEW_GUIDE&&s_sheet);}
 pager_page_key(PIKO_PAGER_BACK,BSP_BTN_LONG);assert(pairing_window&&!s_sheet);
 capture(d,argv[1],"guide-pairing-window");
 for(unsigned tick=0;tick<20;tick++){pager_page_decorate(title,notice,hint,true);assert(s_view==VIEW_GUIDE&&!s_sheet&&pairing_window);}
 pairing_window=false;

 on_ble_state(PAGER_BLE_READY,"Martin's MacBook Pro with an extremely long computer name");s_view=VIEW_MAIN;
 for(unsigned mode=0;mode<PAGER_MODE_COUNT;mode++){s_mode=mode;char n[24];snprintf(n,sizeof(n),"main-%u",mode);capture(d,argv[1],n);}
 assert(strstr(lv_label_get_text(m_peer),"Martin")!=NULL);
 assert(lv_font_get_glyph_dsc(&peer_icon_font,&icon,0x6f14,0)&&!icon.is_placeholder);
 on_ble_state(PAGER_BLE_READY,"这是一个名称很长的演示电脑");capture(d,argv[1],"main-chinese");
 pager_page_key(PIKO_PAGER_HOLD_UP,BSP_BTN_LONG);assert(s_sheet);s_sheet=false;
 pager_page_key(PIKO_PAGER_HOLD_DOWN,BSP_BTN_LONG);assert(s_sheet);s_sheet_sel=1;capture(d,argv[1],"sheet");s_sheet=false;
 flash(TXT_OFFLINE,C_AMBER);capture(d,argv[1],"toast");s_flash_deadline=0;
 s_present=true;s_view=VIEW_PRESENT;lv_label_set_text(p_timer,"1:23:45");capture(d,argv[1],"present");
 s_view=VIEW_BLACKOUT;capture(d,argv[1],"black");
 on_ble_state(PAGER_BLE_ADVERTISING,"");capture(d,argv[1],"disconnected");assert(s_view==VIEW_GUIDE&&!s_present);
 for(unsigned i=0;i<10;i++){
  pager_page_destroy();pager_page_build(lv_screen_active());s_view=VIEW_MAIN;s_locked=true;on_ble_state(PAGER_BLE_READY,"Mac");
  pager_page_decorate(title,notice,hint,true);check_bounds("re-enter");
 }
 puts("PASS: actual pager LVGL states, icon fallback and repeated rebuilding");
}
