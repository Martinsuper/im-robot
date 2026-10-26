#!/usr/bin/env python3
"""Build real native LVGL and assert navigation geometry and wrapped page labels; no hardware."""
from pathlib import Path
import argparse
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--build-dir',type=Path,default=Path(tempfile.gettempdir())/'piko-navigation-layout-test')
args=parser.parse_args();work=args.build_dir.resolve();work.mkdir(parents=True,exist_ok=True)
source=(root/'main/main.c').read_text();harness=(root/'tests/navigation_layout_host.c').read_text()
for signature in ['static void create_navigation(', 'static void ui_navigation(']:
    a=source.index(signature);body=source[a:source.index('\n}',a)+2]
    harness=harness.replace('/* '+signature+' inserted by runner */',body)
(work/'main.c').write_text(harness)
(work/'lv_conf.h').write_text('''#define LV_COLOR_DEPTH 16
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_MONTSERRAT_36 1
#define LV_USE_LOG 0
#define LV_USE_OS LV_OS_NONE
''')
(work/'CMakeLists.txt').write_text(f'''cmake_minimum_required(VERSION 3.16)
project(navigation_layout C CXX)
set(LV_BUILD_CONF_PATH "{work}/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
add_subdirectory("{root}/managed_components/lvgl__lvgl" lvgl)
add_executable(navigation_layout main.c "{root}/main/piko_ui_small.c")
target_link_libraries(navigation_layout PRIVATE lvgl m)
''')
with (work/'build.log').open('w') as log:
    subprocess.run(['cmake','-S',str(work),'-B',str(work/'build')],stdout=log,stderr=log,check=True)
    subprocess.run(['cmake','--build',str(work/'build'),'-j','8'],stdout=log,stderr=log,check=True)
subprocess.run([str(work/'build/navigation_layout'),str(work/'navigation.ppm')],check=True,timeout=15)
print('Layout image:',work/'navigation.ppm')
