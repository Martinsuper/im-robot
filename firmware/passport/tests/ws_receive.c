#include "ws_receive.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
    char buf[9];
    piko_ws_receive_t s = {0};
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 5, true, "he", 2));
    assert(piko_ws_receive(&s, buf, sizeof(buf), 1, 2, 5, true, "llo", 3));
    assert(!strcmp(buf, "hello"));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 2, 0, 4, false, "1234", 4));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 0, 0, 6, false, "567890", 6));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 0, 0, 2, true, "xx", 2));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 0, 0, 1, true, "x", 1));
    assert(piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 2, true, "ok", 2));
    assert(!strcmp(buf, "ok"));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 10, true, "12345", 5));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 1, 5, 10, true, "67890", 5));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 2, false, "ab", 2));
    assert(piko_ws_receive(&s, buf, sizeof(buf), 0, 0, 2, true, "cd", 2));
    assert(!strcmp(buf, "abcd"));
    assert(!piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 1, true, NULL, -1));
    assert(piko_ws_receive(&s, buf, sizeof(buf), 1, 0, 8, true, "12345678", 8));
    puts("PASS: WebSocket chunks, continuation frames, oversized-message discard and recovery");
}
