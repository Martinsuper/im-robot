#include "lvgl.h"
#include <stdio.h>
#include <stdint.h>
#include <assert.h>
LV_FONT_DECLARE(piko_ui_small);
LV_FONT_DECLARE(piko_seg7);
LV_FONT_DECLARE(piko_seg7_small);
#define PIKO_CARD 0xffffff
#define PIKO_CARD_BORDER 0x888888

#define PIKO_INK 0x26331c
#define PIKO_MUTED 0x666666
#define PIKO_ACCENT 0x00aa66
static lv_obj_t *zone_clk,*clk_lcd,*clk_menu_box,*clk_bbar,*clk_bfill;
static uint8_t clk_last_sec,clk_menu_open,clk_menu_row,clk_idle_mode=1,clk_bright=3;
#define PIKO_CLK_IDLE_MODES 3
static lv_obj_t *clk_ghost, *clk_time_label, *clk_sec_label;
static lv_obj_t *clk_wk[7], *clk_moon, *clk_moon_disc, *clk_batt[5];
static lv_obj_t *clk_brand_sub, *clk_wt, *clk_lunar, *clk_date, *clk_doy, *clk_temp;
static lv_obj_t *clk_menu_row_obj[2], *clk_menu_val[2];
static const uint8_t clk_bright_pct[] = {5, 25, 50, 75, 100};
/* static lv_obj_t *ui_zone( inserted by runner */
/* static void create_zone_clk( inserted by runner */
/* static void clk_show_menu( inserted by runner */
static uint16_t pixels[240*320];
static void flush(lv_display_t*d,const lv_area_t*a,uint8_t*p){(void)a;(void)p;lv_display_flush_ready(d);}
int main(int argc,char **argv){
 lv_init();
 lv_font_glyph_dsc_t degree;
 assert(lv_font_get_glyph_dsc(&piko_ui_small,&degree,0x00b0,'C')&&!degree.is_placeholder);
 lv_display_t*d=lv_display_create(240,320);
 lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);
 lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);
 lv_display_set_flush_cb(d,flush);
 create_zone_clk();lv_obj_set_hidden(zone_clk,false);clk_show_menu();
 lv_label_set_text(clk_time_label,"23:58");lv_label_set_text(clk_sec_label,"59");
 lv_label_set_text(clk_wt,"WT UTC 15:58");lv_label_set_text(clk_lunar,"农历九月十六");
 lv_label_set_text(clk_date,"10-25");lv_label_set_text(clk_doy,"WK43 · D298");
 lv_obj_update_layout(lv_screen_active());
 lv_obj_t* rows[]={clk_time_label,clk_sec_label,clk_wt,clk_lunar,clk_date,clk_doy,clk_temp};
 for(unsigned i=0;i<sizeof(rows)/sizeof(rows[0]);i++){
  lv_area_t a;lv_obj_get_coords(rows[i],&a);printf("%u: %d,%d..%d,%d\n",i,a.x1,a.y1,a.x2,a.y2);
 }
 lv_area_t utc,lunar,date,secs,hours;
 lv_obj_get_coords(clk_wt,&utc);lv_obj_get_coords(clk_lunar,&lunar);lv_obj_get_coords(clk_date,&date);lv_obj_get_coords(clk_sec_label,&secs);
 lv_obj_get_coords(clk_time_label,&hours);assert(hours.x2<secs.x1);
 assert(secs.y2<utc.y1&&utc.y2<lunar.y1&&lunar.y2<date.y1);
 lv_refr_now(d);
 FILE*f=fopen(argc>1?argv[1]:"clock.ppm","wb");fprintf(f,"P6\n240 320\n255\n");
 for(unsigned i=0;i<240*320;i++){uint16_t v=pixels[i];uint8_t p[]={((v>>11)&31)*255/31,((v>>5)&63)*255/63,(v&31)*255/31};fwrite(p,1,3,f);}fclose(f);
 clk_menu_open=1;clk_show_menu();
 assert(lv_obj_has_flag(clk_lcd,LV_OBJ_FLAG_HIDDEN));
 assert(!lv_obj_has_flag(clk_menu_box,LV_OBJ_FLAG_HIDDEN));
 clk_menu_open=0;clk_show_menu();assert(!lv_obj_has_flag(clk_lcd,LV_OBJ_FLAG_HIDDEN));
 puts("PASS: actual LVGL clock row bounds and opaque menu transition");
}
