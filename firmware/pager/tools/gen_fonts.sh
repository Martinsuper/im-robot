#!/bin/bash
# 从 main/*.c 的字符串里收集界面用到的非 ASCII 字符，生成只含这些字的中文字体。
# 字体：LVGL 自带的思源黑体 SourceHanSansSC-Normal.otf（SIL OFL 1.1）。
# 工具：lv_font_conv 1.5.2（npm），用 LV_FONT_CONV 指定路径。字体变量名取输出文件名。
#
#   LV_FONT_CONV=/path/to/node_modules/.bin/lv_font_conv tools/gen_fonts.sh
#
# 改了界面文案就重跑这个脚本；启动日志里的 "Glyph check" 会报出漏掉的字。
set -euo pipefail
cd "$(dirname "$0")/.."

CONV=${LV_FONT_CONV:?设置 LV_FONT_CONV 为 lv_font_conv 的路径}
SRC_FONT=managed_components/lvgl__lvgl/scripts/built_in_font/SourceHanSansSC-Normal.otf
OUT=assets/fonts
mkdir -p "$OUT"

python3 - main/*.c >"$OUT/charset.txt" <<'EOF'
import re, sys
chars = set()
for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    for literal in re.findall(r'"((?:[^"\\\n]|\\.)*)"', text):
        chars.update(c for c in literal if ord(c) > 0x7E)
print("".join(sorted(chars)), end="")
EOF
echo "收集到 $(python3 -c "import sys;print(len(open(sys.argv[1],encoding='utf-8').read()))" "$OUT/charset.txt") 个非 ASCII 字符"

# 16px 还要显示对方的设备名（可能是任意中文名），额外放进 GB2312 一级常用字 3755 个
# 和设备名里常见的弯引号、全角符号。
python3 -c '
chars = [bytes([hi, lo]).decode("gb2312") for hi in range(0xB0, 0xD8) for lo in range(0xA1, 0xFF)
         if not (hi == 0xD7 and lo > 0xF9)]
print("".join(chars) + "\u2018\u2019\u201c\u201d\uff08\uff09\uff0d\u00b7", end="")
' >"$OUT/charset_names.txt"

for size in 16 24; do
  symbols=$(cat "$OUT/charset.txt")
  if [ "$size" = 16 ]; then symbols+=$(cat "$OUT/charset_names.txt"); fi
  "$CONV" --font "$SRC_FONT" --size "$size" --bpp 4 --format lvgl --no-compress \
    -r 0x20-0x7E --symbols "$symbols" \
    --lv-include lvgl.h \
    -o "$OUT/pager_font_$size.c"
done
ls -la "$OUT"
