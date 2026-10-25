#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
typedef struct { bool held,started,suppress_click; int64_t pressed_at; } piko_voice_key_t;
static inline void piko_voice_key_reset(piko_voice_key_t *s){*s=(piko_voice_key_t){0};}
static inline void piko_voice_key_press(piko_voice_key_t *s,int64_t now,bool interrupted){s->held=true;s->started=false;s->suppress_click=interrupted;s->pressed_at=now;}
static inline bool piko_voice_key_tick(piko_voice_key_t *s,int64_t now){if(s->held && !s->started && now-s->pressed_at>=300000){s->started=true;s->suppress_click=true;return true;}return false;}
static inline bool piko_voice_key_release(piko_voice_key_t *s){s->held=false;return s->started;}
static inline bool piko_voice_key_click(piko_voice_key_t *s){bool tap=!s->suppress_click;s->suppress_click=false;s->started=false;return tap;}

/* Keep recognized text visible while the agent works, as in the original UI.
 * Recording and approval have dedicated screens and must always take priority. */
static inline const char *piko_voice_readable_text(bool busy, const char *stage,
                                                 const char *transcript, const char *reply) {
  if(!busy || strcmp(stage,"listening")==0 || strcmp(stage,"awaiting_confirmation")==0)
    return NULL;
  if(reply[0])return reply;
  return transcript[0]?transcript:NULL;
}

/* A normal progress update is not approval, rejection or cancellation. */
static inline bool piko_confirmation_holds_status(bool pending,const char *stage){
  return pending && strcmp(stage,"done") && strcmp(stage,"cancelled") &&
      strcmp(stage,"error") && strcmp(stage,"text_only");
}
