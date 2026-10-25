#!/usr/bin/env python3
"""Compile the production upload loop and cancellation function with transport stubs."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / "main/main.c").read_text()
cancel = source.split("static void voice_cancel(void) {", 1)[1].split("\n}", 1)[0]
upload = source.split("static void voice_tick(void)", 1)[1]
upload = upload[upload.index("static uint8_t capture["):upload.index("if (voice_stop_requested && audio.record_done")]
periodic=source[source.index('    // Keys may have just started recording.'):source.index('    if(page==PAGE_INPUT){', source.index('    // Keys may have just started recording.'))]
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#define PASSPORT_CAPTURE_BYTES 1024
#define PASSPORT_CAPTURE_BLOCKS 16
#define pdMS_TO_TICKS(x) (x)
#define portMAX_DELAY 0
#define atomic_load(x) (*(x))
static bool long_upload=true, voice_stop_requested;
static uint64_t voice_sent;
static int pending, sent, failed, socket_client=1, mutex, socket_mutex;
static bool cancelled;
static int64_t now;
static int send_cost=3;
static int64_t esp_timer_get_time(void){return now;}
#define ESP_LOGE(tag,...) ((void)fprintf(stderr,__VA_ARGS__))
static bool esp_websocket_client_is_connected(int s){return s!=0;}
static struct { bool voice_busy, voice_cancel_requested, authenticated; char confirmation_id[8],voice_stage[24]; int confirmation_gate; } model;
static int passport_audio_cancel(void){cancelled=true;return 0;}
static void passport_audio_stop_record(void){}
static int xSemaphoreTake(int m,int t){(void)m;(void)t;return 0;}
static int xSemaphoreGive(int m){(void)m;return 0;}
static void piko_confirmation_clear(int *p){*p=0;}
static void copy_text(char *p,size_t n,const char *v){snprintf(p,n,"%s",v);}
static int battery_calls,heartbeat_calls;
static void pager_page_set_battery(int b){(void)b;}
static int bsp_battery_soc(void){battery_calls++;return 90;}
#define FW_VERSION "test"
static int packet(const char *type){assert(!strcmp(type,"heartbeat"));return 2;}
static void cJSON_AddNumberToObject(int j,const char *k,int n){(void)j;(void)k;(void)n;}
static void cJSON_AddStringToObject(int j,const char *k,const char *v){(void)j;(void)k;(void)v;}
static int voice_packet(const char *type){assert(!strcmp(type,"voice_cancel"));return 1;}
static void send_json(int packet){
    if(packet==2){heartbeat_calls++;return;}
    assert(packet==1 && cancelled && !model.voice_busy && !model.voice_cancel_requested);
    assert(!model.confirmation_id[0] && !strcmp(model.voice_stage,"cancelled"));
}
static bool passport_audio_capture(uint8_t *p,size_t *n){
    (void)p;if(!pending)return false;pending--;*n=1024;return true;
}
static int esp_websocket_client_send_bin(int s,const char *p,size_t n,int timeout){
    (void)s;(void)p;assert(timeout==200);now+=(send_cost<timeout?send_cost:timeout)*1000;sent++;return failed || send_cost>timeout?-1:(int)n;
}
static void voice_fail(const char *s){(void)s;failed++;}
static void voice_cancel(void){
CANCEL
}
static bool drain(void){
UPLOAD
return capture_drained;
}
static void periodic_after_start(void){
    __typeof__(model) m={0}; // The loop started with a stale idle state.
    int battery=-1;bool battery_ok=true;
    int64_t battery_at=0,heartbeat_at=0;
    (void)battery;
PERIODIC
}
int main(void){
    model.voice_busy=model.voice_cancel_requested=true;
    strcpy(model.confirmation_id,"id");voice_cancel();
    // Five queued blocks after a 160ms UI pause must drain in one turn.
    pending=5;assert(drain());assert(sent==5 && pending==0 && voice_sent==5120);
    assert(drain());assert(sent==5);
    // Repeated 160ms UI stalls used to grow the queue by three blocks per turn.
    for(int turn=0;turn<100;turn++){
        now+=160000;pending+=5;assert(pending<=16);assert(drain());assert(pending==0);
    }
    // Temporary 80ms Wi-Fi stalls must succeed, then yield to the UI.
    pending=16;send_cost=80;int64_t start=now;int before=sent;
    assert(!drain());assert(now-start==80000 && sent-before==1 && pending==15 && !failed);
    // A send at the end of a slice still gets the full transport timeout.
    send_cost=13;pending=16;start=now;assert(!drain());assert(now-start==52000 && !failed);
    // Over 60 seconds of PCM, with recurring 80ms stalls, must preserve bytes.
    pending=0;send_cost=3;uint64_t initial_bytes=voice_sent;
    for(int turn=0;turn<625;turn++){
        now+=96000;pending+=3;assert(pending<=PASSPORT_CAPTURE_BLOCKS);
        send_cost=turn%20==0?80:3;drain();assert(!failed);
    }
    send_cost=3;drain();assert(!pending && voice_sent-initial_bytes==625*3*1024);
    // Persistent errors stop without retrying a possibly partial frame.
    pending=4;failed=1;before=sent;drain();assert(pending==3 && failed==2 && sent==before+1);
    now=6000000;model.voice_busy=true;model.authenticated=true;
    strcpy(model.voice_stage,"listening");periodic_after_start();
    assert(battery_calls==0 && heartbeat_calls==0);
    strcpy(model.voice_stage,"thinking");periodic_after_start();
    assert(battery_calls==0 && heartbeat_calls==1);
    puts("PASS: upload catches up after UI jitter, Wi-Fi stalls, stable frame timeout, failure and cancellation");
}
'''.replace('CANCEL', cancel).replace('UPLOAD', upload.replace('return;', 'return false;')).replace('PERIODIC', periodic.replace('cJSON *j', 'int j'))
with tempfile.TemporaryDirectory(prefix="piko-scheduling-") as temp:
    path = Path(temp) / "test.c"
    path.write_text(harness)
    binary = Path(temp) / "test"
    subprocess.run(["cc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", str(path), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)
