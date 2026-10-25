#!/usr/bin/env python3
"""Render the production pager with real LVGL; assert visible label geometry."""
from pathlib import Path
import argparse
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--build-dir',type=Path,default=Path(tempfile.gettempdir())/'piko-pager-layout-test')
work=p.parse_args().build_dir.resolve();work.mkdir(parents=True,exist_ok=True)
(work/'lv_conf.h').write_text('''#define LV_COLOR_DEPTH 16
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_MONTSERRAT_36 1
#define LV_USE_LOG 0
#define LV_USE_OS LV_OS_NONE
''')
(work/'CMakeLists.txt').write_text(f'''cmake_minimum_required(VERSION 3.16)
project(pager_layout C CXX)
set(LV_BUILD_CONF_PATH "{work}/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
add_subdirectory("{root}/managed_components/lvgl__lvgl" lvgl)
add_executable(pager_layout "{root}/tests/pager_layout_host.c" "{root}/main/pager_keys.c" "{root}/main/piko_ui_small.c" "{root}/main/piko_ui_title.c" "{root}/main/piko_chinese.c")
target_include_directories(pager_layout PRIVATE "{root}/tests/pager_layout_stubs" "{root}/tests/stubs" "{root}/main")
target_link_libraries(pager_layout PRIVATE lvgl m)
''')
with (work/'build.log').open('w') as log:
 subprocess.run(['cmake','-S',str(work),'-B',str(work/'build')],stdout=log,stderr=log,check=True)
 subprocess.run(['cmake','--build',str(work/'build'),'-j','8'],stdout=log,stderr=log,check=True)
subprocess.run([str(work/'build/pager_layout'),str(work)],check=True,timeout=20)
print('Rendered images:',work)
