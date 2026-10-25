/* UDP wire compatibility with manchunx7-bit/folo-ai-passport-voice.
 * ADPCM implementation and license are retained in voice_input/.
 * No remote commands or ASR are executed by this module.
 */
#include "voice_input.h"
#include "voice_input/adpcm.h"
#include "passport_audio.h"
#include "cJSON.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "lwip/sockets.h"
#include <fcntl.h>
#include <errno.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <unistd.h>

#define VOICE_PORT 33333
#define PEER_TIMEOUT_US 3000000
#define RECORD_LIMIT_US 60000000
static int fd = -1;
static struct sockaddr_in peer;
static voice_input_status_t state;
static int64_t seen_at, ping_at, started_at, stopped_at, enter_at;
static int16_t pcm[ADPCM_BLOCK_SAMPLES];
static size_t samples;
static uint8_t sequence;
static adpcm_state_t encoder;

static bool send_packet(const void *data, size_t len) {
    if (fd < 0 || !state.candidate) return false;
    // Wi-Fi TX buffers are bounded. Brief congestion must not end a recording.
    // At most 50 ms, well within the 512 ms capture queue budget.
    for (unsigned attempt = 0; attempt < 6; attempt++) {
        ssize_t sent = sendto(fd, data, len, 0, (struct sockaddr *)&peer, sizeof(peer));
        if (sent == (ssize_t)len) return true;
        int reason = errno;
        bool transient = sent < 0 && (reason == ENOMEM || reason == ENOBUFS ||
                                      reason == EAGAIN || reason == EWOULDBLOCK);
        if (!transient || attempt == 5) {
            ESP_LOGI("voice_input", "send failed errno=%d bytes=%u", reason, (unsigned)len);
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return false;
}
static bool event(const char *json) {
    uint8_t packet[160];
    size_t len = strlen(json);
    if (len + 1 > sizeof(packet)) return false;
    packet[0] = 2;
    memcpy(packet + 1, json, len);
    return send_packet(packet, len + 1);
}
static bool audio_block(void) {
    uint8_t packet[3 + ADPCM_BLOCK_BYTES];
    packet[0] = 1; packet[1] = sequence++; packet[2] = 0x80;
    size_t bytes = adpcm_encode_block(&encoder, pcm, ADPCM_BLOCK_SAMPLES,
                                     packet + 3, ADPCM_BLOCK_BYTES);
    if (bytes != ADPCM_BLOCK_BYTES || !send_packet(packet, bytes + 3)) return false;
    state.blocks++;
    samples = 0;
    return true;
}
static void finish(bool flush) {
    if (!state.recording && !state.draining) return;
    if (flush && samples) {
        memset(pcm + samples, 0, (ADPCM_BLOCK_SAMPLES - samples) * sizeof(*pcm));
        if (!audio_block()) state.error = true;
    }
    event("{\"event\":\"voice.end\"}\n");
    ESP_LOGI("voice_input", "end blocks=%u error=%d", state.blocks, state.error);
    passport_audio_cancel();
    state.recording = state.draining = false;
    samples = 0;
}
bool voice_input_open(void) {
    voice_input_close();
    state = (voice_input_status_t){0};
    seen_at = ping_at = started_at = stopped_at = enter_at = 0;
    fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) { state.error = true; return false; }
    struct sockaddr_in local = {.sin_family = AF_INET, .sin_port = htons(VOICE_PORT),
                               .sin_addr.s_addr = htonl(INADDR_ANY)};
    if (bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0 ||
        fcntl(fd, F_SETFL, O_NONBLOCK) != 0) {
        close(fd); fd = -1; state.error = true; return false;
    }
    state.opened = true;
    return true;
}
void voice_input_close(void) {
    finish(false);
    if (fd >= 0) close(fd);
    fd = -1;
    state = (voice_input_status_t){0};
}
bool voice_input_select(void) {
    if (!state.opened || !state.candidate) return false;
    /* Physical OK pins this candidate; other PCs cannot redirect an active session. */
    state.selected = event("{\"event\":\"device.hello\",\"proto\":1}\n");
    ESP_LOGI("voice_input", "select peer=%s selected=%d", state.peer, state.selected);
    state.error = !state.selected;
    return state.selected;
}
void voice_input_press(void) {
    if (!state.selected || state.recording || state.draining) return;
    if (!event("{\"event\":\"voice.start\",\"audio\":\"ima_adpcm\"}\n")) {
        state.error = true; return;
    }
    if (!passport_audio_record()) {
        event("{\"event\":\"voice.end\"}\n"); state.error = true; return;
    }
    samples = sequence = 0;
    adpcm_state_reset(&encoder);
    state.blocks = 0; state.error = false; state.recording = true;
    ESP_LOGI("voice_input", "start peer=%s", state.peer);
    started_at = esp_timer_get_time();
}
void voice_input_release(void) {
    if (!state.recording) return;
    passport_audio_stop_record();
    state.recording = false; state.draining = true;
    stopped_at = esp_timer_get_time();
}
void voice_input_enter_key(void) {
    int64_t now = esp_timer_get_time();
    if (!state.selected || state.recording || state.draining ||
        (enter_at && now - enter_at < 600000)) return;
    if (!event("{\"event\":\"key.action\",\"action\":\"enter\"}\n")) state.error = true;
    enter_at = now;
}
void voice_input_tick(bool wifi_ready) {
    if (fd < 0) return;
    int64_t now = esp_timer_get_time();
    if (!wifi_ready) {
        finish(false); state.candidate = state.selected = false; state.peer[0] = 0;
        return;
    }
    /* Bounded work: a noisy LAN cannot starve UI/input or audio draining. */
    for (unsigned i = 0; i < 4; i++) {
        uint8_t data[512]; struct sockaddr_in from; socklen_t len = sizeof(from);
        ssize_t n = recvfrom(fd, data, sizeof(data) - 1, 0, (struct sockaddr *)&from, &len);
        if (n <= 0) break;
        if (from.sin_port != htons(VOICE_PORT)) continue;
        bool same = state.candidate && from.sin_addr.s_addr == peer.sin_addr.s_addr;
        if (state.candidate && !same) continue;
        if (data[0] == 3) {
            data[n] = 0;
            cJSON *json = cJSON_Parse((char *)data + 1);
            const cJSON *v = cJSON_GetObjectItemCaseSensitive(json, "v");
            const cJSON *role = cJSON_GetObjectItemCaseSensitive(json, "role");
            const cJSON *port = cJSON_GetObjectItemCaseSensitive(json, "port");
            bool valid = cJSON_IsNumber(v) && v->valuedouble == 1 &&
                cJSON_IsString(role) && strcmp(role->valuestring, "pc") == 0 &&
                cJSON_IsNumber(port) && port->valuedouble == VOICE_PORT;
            cJSON_Delete(json);
            if (!valid) continue;
            peer = from; state.candidate = true; seen_at = now;
            inet_ntop(AF_INET, &peer.sin_addr, state.peer, sizeof(state.peer));
        } else if (data[0] == 4 && same) seen_at = now;
        /* Deliberately ignore all incoming EVENT/AUDIO/approval packets. */
    }
    if (state.candidate && now - seen_at >= PEER_TIMEOUT_US) {
        finish(false); state.candidate = state.selected = false; state.peer[0] = 0;
    }
    if (state.selected && now - ping_at >= 1000000) {
        const uint8_t ping = 4; send_packet(&ping, 1); ping_at = now;
    }
    if (state.recording && now - started_at >= RECORD_LIMIT_US) voice_input_release();
    if (!state.recording && !state.draining) return;
    passport_audio_status_t audio = passport_audio_status();
    if (audio.error) {
        ESP_LOGI("voice_input", "capture failed error=%d blocks=%u", audio.error, state.blocks);
        state.error = true; finish(false); return;
    }
    uint8_t captured[PASSPORT_CAPTURE_BYTES]; size_t bytes;
    for (unsigned block = 0; block < PASSPORT_CAPTURE_BLOCKS; block++) {
        if (!passport_audio_capture(captured, &bytes)) break;
        for (size_t i = 0; i + 1 < bytes; i += 2) {
            pcm[samples++] = (int16_t)((uint16_t)captured[i] | ((uint16_t)captured[i + 1] << 8));
            if (samples == ADPCM_BLOCK_SAMPLES && !audio_block()) {
                state.error = true; finish(false); return;
            }
        }
    }
    if (state.draining && audio.record_done) finish(true);
    else if (state.draining && now - stopped_at > 500000) { state.error = true; finish(false); }
}
voice_input_status_t voice_input_status(void) { return state; }
