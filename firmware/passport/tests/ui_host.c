#include <assert.h>
#include <stdio.h>
#include "ui_text.h"
#include "ui_input.h"
static unsigned width(uint32_t cp,uint32_t next){(void)next;return cp<128?1:2;}
static void roundtrip(const char *text,unsigned cols,unsigned rows){
 char joined[8192]={0},page[512];size_t used=0;
 unsigned count=piko_text_layout(text,cols,rows,UINT32_MAX,NULL,0,width);
 assert(count<200);
 for(unsigned p=0;p<count;p++){
  assert(piko_text_layout(text,cols,rows,p,page,sizeof(page),width)==count);
  for(size_t i=0;page[i];i++)if(page[i]!='\n')joined[used++]=page[i];
 }
 char expected[8192]={0};size_t j=0;for(size_t i=0;text[i];i++)if(text[i]!='\n')expected[j++]=text[i];
 assert(!strcmp(joined,expected));
}
int main(void){
 const char *samples[]={"", "你好，我是 Piko——今天辛苦了！喝口水 · 休息一下。「现在开始」；下一步：①整理桌面；②打开文档。", "abc (def) 1234! hi?", "第一行\n第二行\n\n第三行", "甲乙丙丁，。！？甲乙丙丁", "a\xf0\x9f\x98\x80z"};
 for(size_t s=0;s<sizeof(samples)/sizeof(*samples);s++)for(unsigned w=2;w<30;w++)for(unsigned rows=1;rows<5;rows++)roundtrip(samples[s],w,rows);
 uint32_t cp;assert(piko_utf8("\xe4",&cp)==1 && cp=='?');assert(piko_utf8("\xf0\x80\x80\x80",&cp)==1 && cp=='?');
 char page[128];piko_text_layout("甲乙丙，丁",6,2,0,page,sizeof(page),width);assert(!strcmp(page,"甲乙\n丙，丁"));
 piko_voice_key_t key={0};piko_voice_key_press(&key,100,false);assert(!piko_voice_key_tick(&key,299999));assert(!piko_voice_key_release(&key));assert(piko_voice_key_click(&key));
 piko_voice_key_press(&key,0,false);assert(piko_voice_key_tick(&key,300000));assert(!piko_voice_key_tick(&key,600000));assert(piko_voice_key_release(&key));assert(!piko_voice_key_click(&key));
 piko_voice_key_press(&key,0,true);assert(!piko_voice_key_release(&key));assert(!piko_voice_key_click(&key));
 piko_voice_key_press(&key,0,true);assert(piko_voice_key_tick(&key,300000));piko_voice_key_reset(&key);assert(!piko_voice_key_tick(&key,900000));
 puts("UI pagination and hold-to-talk tests passed");
}
