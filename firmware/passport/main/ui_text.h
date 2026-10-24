#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef unsigned (*piko_glyph_width_fn)(uint32_t, uint32_t);
static inline size_t piko_utf8(const char *s, uint32_t *cp) {
  const unsigned char *p=(const unsigned char *)s;
  if (!p[0]) { *cp=0; return 0; }
  if (p[0]<0x80) { *cp=p[0]; return 1; }
  unsigned n=p[0]>=0xf0?4:p[0]>=0xe0?3:p[0]>=0xc2?2:0;
  if (!n) { *cp='?'; return 1; }
  uint32_t value=p[0]&((1u<<(7-n))-1);
  for (unsigned k=1;k<n;k++) {
    if (!p[k] || (p[k]&0xc0)!=0x80) { *cp='?'; return 1; }
    value=(value<<6)|(p[k]&0x3f);
  }
  if (value>0x10ffff || (value>=0xd800 && value<=0xdfff) ||
      (n==2 && value<0x80) || (n==3 && value<0x800) || (n==4 && value<0x10000)) { *cp='?'; return 1; }
  *cp=value; return n;
}
static inline bool piko_closing(uint32_t cp) {
  const uint32_t chars[]={',','.',';',':','!','?','%',')',']','}',0xff0c,0x3002,0xff01,0xff1f,0xff1a,0xff1b,0x3001,0xff09,0x300b,0x3011,0x300d,0x300f,0x201d,0x2019};
  for(size_t k=0;k<sizeof(chars)/sizeof(*chars);k++)if(cp==chars[k])return true;
  return false;
}
static inline bool piko_opening(uint32_t cp) {
  return cp=='(' || cp=='[' || cp=='{' || cp==0xff08 || cp==0x300a || cp==0x3010 || cp==0x300c || cp==0x300e || cp==0x201c || cp==0x2018;
}
static inline void piko_page_append(char *out,size_t cap,size_t *used,const char *s,size_t n) {
  if(out && *used+n<cap){memcpy(out+*used,s,n);*used+=n;out[*used]=0;}
}
// Layout uses actual glyph advances, preserves UTF-8 and keeps closing
// punctuation with preceding text rather than stranded at a line/page start.
static inline unsigned piko_text_layout(const char *text,unsigned width,unsigned rows,unsigned wanted,char *out,size_t cap,piko_glyph_width_fn glyph) {
  if(out && cap)out[0]=0;
  if(!rows || !width || !text || !*text)return 1;
  const char *cursor=text;unsigned line=0;size_t used=0;
  while(*cursor){
    const char *start=cursor,*last=NULL;unsigned advance=0,count=0;uint32_t cp=0,previous=0;
    while(*cursor && *cursor!='\n'){
      size_t n=piko_utf8(cursor,&cp);uint32_t next;piko_utf8(cursor+n,&next);
      unsigned w=glyph(cp,next);if(!w)w=4;
      if(count && advance+w>width)break;
      last=cursor;previous=cp;cursor+=n;advance+=w;count++;
    }
    if(*cursor && *cursor!='\n' && count>1){
      piko_utf8(cursor,&cp);
      if(piko_closing(cp) || piko_opening(previous))cursor=last;
    }
    if(line/rows==wanted){
      if(line%rows)piko_page_append(out,cap,&used,"\n",1);
      piko_page_append(out,cap,&used,start,(size_t)(cursor-start));
    }
    line++;
    if(*cursor=='\n')cursor++;
  }
  return (line+rows-1)/rows;
}
