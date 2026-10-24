#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct { bool held,started,suppress_click; int64_t pressed_at; } piko_voice_key_t;
static inline void piko_voice_key_reset(piko_voice_key_t *s){*s=(piko_voice_key_t){0};}
static inline void piko_voice_key_press(piko_voice_key_t *s,int64_t now,bool interrupted){s->held=true;s->started=false;s->suppress_click=interrupted;s->pressed_at=now;}
static inline bool piko_voice_key_tick(piko_voice_key_t *s,int64_t now){if(s->held && !s->started && now-s->pressed_at>=300000){s->started=true;s->suppress_click=true;return true;}return false;}
static inline bool piko_voice_key_release(piko_voice_key_t *s){s->held=false;return s->started;}
static inline bool piko_voice_key_click(piko_voice_key_t *s){bool tap=!s->suppress_click;s->suppress_click=false;s->started=false;return tap;}
