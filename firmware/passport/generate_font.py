#!/usr/bin/env python3
"""Generate flash-only Chinese UI fonts (requires fonttools and Node/npm)."""
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
import urllib.request
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
REV = "f8d157532fbfaeda587e826d4cd5b21a49186f7c"
BASE = f"https://raw.githubusercontent.com/notofonts/noto-cjk/{REV}/Sans"
chars = set(chr(i) for i in range(32, 127))
for high in range(0xA1, 0xF8):
    for low in range(0xA1, 0xFF):
        try:
            chars.add(bytes([high, low]).decode("gb2312"))
        except UnicodeDecodeError:
            pass
# GB2312 alone omits modern em/en dashes, middle dots and bullet points.
for start, stop in [(0xA0, 0x100), (0x2000, 0x2070), (0x3000, 0x3040),
                    (0xFE10, 0xFE20), (0xFE30, 0xFE70), (0xFF01, 0xFF66),
                    (0x2190, 0x219A), (0x2713, 0x2719)]:
    chars.update(chr(i) for i in range(start, stop)
                 if unicodedata.category(chr(i))[0] != "C")
chars.add("□")
cache = Path(tempfile.gettempdir()) / "piko-font-cache"
cache.mkdir(exist_ok=True)
source = cache / f"NotoSansSC-{REV}.otf"
if not source.exists():
    urllib.request.urlretrieve(f"{BASE}/SubsetOTF/SC/NotoSansSC-Regular.otf", source)
urllib.request.urlretrieve(f"{BASE}/LICENSE", ROOT / "main/LICENSE.font.txt")
font = TTFont(source)
available = set(font.getBestCmap())
font.close()
chars = {c for c in chars if ord(c) in available}
# Backend confirmation previews must use the real glyph coverage, never a wish list.
(ROOT / "main/font-characters.txt").write_text("".join(sorted(chars)))
# Almanac strings (干支/生肖/建除/宜忌) live in piko_lunar.c; scan both.
ui_text = "".join((ROOT / "main" / name).read_text() for name in
                  ["main.c", "piko_lunar.c", "pager_page.c", "pager_keys.c"])
ui_chars = (set(chr(i) for i in range(32, 127))
            | set(re.findall(r"[\u3000-\u303f\u3400-\u9fff]", ui_text))  # 含「」『』等 CJK 符号
            | set("°℃—–·•…，。！？：；、（）《》【】「」『』“”‘’"))
ui_chars &= chars
specs = [("piko_chinese", 16, chars), ("piko_ui_title", 20, ui_chars),
         ("piko_ui_small", 14, ui_chars)]
for name, size, symbols in specs:
    output = ROOT / f"main/{name}.c"
    subprocess.run(["npx", "--yes", "lv_font_conv@1.5.3", "--font", str(source),
                    "--size", str(size), "--bpp", "2", "--no-compress", "--format", "lvgl",
                    "--symbols", "".join(sorted(symbols)), "-o", str(output)], check=True)
    content = output.read_text()
    content = (f"/* Generated Noto Sans SC {size}px/2bpp. See generate_font.py and LICENSE.font.txt. */\n"
               + content[content.index("*/") + 2:])
    output.write_text(content.replace('"lvgl/lvgl.h"', '"lvgl.h"'))
    print(f"Generated {name}: {len(symbols)} glyphs at {size}px")

# 时钟表盘段码字体：DSEG7 Classic Bold Italic（SIL OFL 1.1，见 fonts/DSEG-LICENSE.txt）。
# 字形仅 0-9 与冒号；残影效果由 LVGL 叠放暗色 "88:88" 底层 label 实现。
dseg = ROOT / "fonts/DSEG7Classic-BoldItalic.ttf"
dseg_symbols = "0123456789:"
for name, size in [("piko_seg7", 44), ("piko_seg7_small", 20)]:
    output = ROOT / f"main/{name}.c"
    subprocess.run(["npx", "--yes", "lv_font_conv@1.5.3", "--font", str(dseg),
                    "--size", str(size), "--bpp", "2", "--no-compress", "--format", "lvgl",
                    "--symbols", dseg_symbols, "-o", str(output)], check=True)
    content = output.read_text()
    content = (f"/* Generated DSEG7 Classic Bold Italic {size}px/2bpp (SIL OFL 1.1, fonts/DSEG-LICENSE.txt). */\n"
               + content[content.index("*/") + 2:])
    output.write_text(content.replace('"lvgl/lvgl.h"', '"lvgl.h"'))
    print(f"Generated {name}: {len(dseg_symbols)} glyphs at {size}px")
