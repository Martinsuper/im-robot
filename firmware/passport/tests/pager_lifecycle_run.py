#!/usr/bin/env python3
"""Exercise production BLE stop ordering, retries and already-stopped handling."""
from pathlib import Path
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
s=(root/'main/pager_ble.c').read_text();a=s.index('esp_err_t pager_ble_stop(');body=s[a:s.index('\n}',a)+2]
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_TIMEOUT 0x107
#define ESP_LOGE(...) ((void)0)
#define pdMS_TO_TICKS(x) (x)
#define BLE_HS_CONN_HANDLE_NONE 0xffff
#define PAGER_BLE_ADVERTISING 0
static bool s_controller_initialized,s_controller_enabled,s_nimble_initialized;
static atomic_bool s_host_exited,s_stopping;
static void *s_dev;
static unsigned s_conn;
static char s_peer_name[48],trace[64],fail_stage;
static bool adv,stall;
static unsigned used,delays;
static int call(char c){trace[used++]=c;trace[used]=0;if(fail_stage==c){fail_stage=0;return -1;}return 0;}
static bool ble_gap_adv_active(void){return adv;}
static void ble_gap_adv_stop(void){adv=false;call('A');}
static int nimble_port_stop(void){int r=call('H');if(!r&&!stall)atomic_store(&s_host_exited,true);return r;}
static int esp_hidd_dev_deinit(void *d){assert(d);return call('I');}
static int esp_nimble_deinit(void){return call('N');}
static int esp_bt_controller_disable(void){return call('C');}
static int esp_bt_controller_deinit(void){return call('D');}
static void set_state(int n){assert(n==0);call('S');}
static void vTaskDelay(unsigned ms){assert(ms==1||ms==10);if(ms==10)delays++;}
FUNCTION
static void start(void){s_controller_initialized=s_controller_enabled=s_nimble_initialized=true;s_host_exited=s_stopping=false;s_dev=(void*)1;s_conn=1;strcpy(s_peer_name,"paired");adv=true;stall=false;trace[0]=0;used=delays=0;}
int main(void){
 assert(pager_ble_stop()==ESP_OK&&used==0);
 for(unsigned cycle=0;cycle<50;cycle++){
  start();assert(pager_ble_stop()==ESP_OK);assert(!strcmp(trace,"AHINCDS"));
  assert(!s_controller_initialized&&!s_controller_enabled&&!s_nimble_initialized&&!s_dev);
  assert(s_host_exited&&s_stopping&&s_conn==BLE_HS_CONN_HANDLE_NONE&&!s_peer_name[0]);
  assert(pager_ble_stop()==ESP_OK&&!strcmp(trace,"AHINCDS"));
 }
 const char stages[]="HINCD";
 for(unsigned i=0;i<sizeof(stages)-1;i++){
  start();fail_stage=stages[i];assert(pager_ble_stop()!=ESP_OK&&s_controller_initialized);
  assert(pager_ble_stop()==ESP_OK&&!s_controller_initialized);
 }
 start();stall=true;assert(pager_ble_stop()==ESP_ERR_TIMEOUT&&delays==200);
 assert(!strcmp(trace,"AH")&&s_dev&&s_nimble_initialized);
 s_host_exited=true;assert(pager_ble_stop()==ESP_OK);
 puts("PASS: 50 BLE lifecycle cycles, teardown ordering, partial-failure retry and bounded host-exit wait");
}
'''.replace('FUNCTION',body)
with tempfile.TemporaryDirectory(prefix='piko-ble-life-') as temp:
    src=Path(temp)/'test.c';src.write_text(harness);binary=Path(temp)/'test'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address',str(src),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=10)
