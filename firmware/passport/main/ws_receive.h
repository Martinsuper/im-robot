#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

typedef struct {
    size_t used;
    int opcode;
    bool active, dropping;
} piko_ws_receive_t;

/* offset/total describe one WebSocket frame; fin ends the whole message.
 * Control frames must be filtered by the caller. */
static inline bool piko_ws_receive(piko_ws_receive_t *s, char *buf, size_t capacity,
                                  int opcode, int offset, int total, bool fin,
                                  const char *data, int len) {
    if ((opcode == 1 || opcode == 2) && offset == 0) {
        *s = (piko_ws_receive_t){.opcode = opcode, .active = true};
    }
    if (!s->active) return false;
    if (len < 0 || offset < 0 || total < 0 || offset > total || len > total - offset ||
        (len && !data) || s->used >= capacity ||
        (size_t)len >= capacity - s->used) {
        s->dropping = true;
    }
    if (!s->dropping) {
        if (len) memcpy(buf + s->used, data, (size_t)len);
        s->used += (size_t)len;
    }
    if (len >= 0 && offset >= 0 && total >= offset && len == total - offset && fin) {
        s->active = false;
        if (!s->dropping) {
            buf[s->used] = 0;
            return true;
        }
    }
    return false;
}
