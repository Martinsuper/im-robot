#!/usr/bin/env python3
"""Host protocol/lifecycle tests using ESP-IDF's actual cJSON parser; no device access."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
IDF = Path(os.environ.get("IDF_PATH", "/tmp/piko-esp-idf"))
JSON = IDF / "components/json/cJSON"
if not (JSON / "cJSON.c").exists():
    raise SystemExit("Set IDF_PATH to ESP-IDF 5.5.3 to use its cJSON parser")
with tempfile.TemporaryDirectory(prefix="passport-input-tests-") as temp:
    binary = Path(temp) / "voice-input-tests"
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
        f"-I{ROOT / 'tests/voice_stubs'}", f"-I{ROOT / 'tests/stubs'}",
        f"-I{ROOT / 'main'}", f"-I{JSON}",
        f"-I{ROOT / 'vendor/ai-passport/components/bsp/include'}",
        str(ROOT / "tests/voice_input_host.c"), str(ROOT / "main/voice_input/adpcm.c"),
        str(JSON / "cJSON.c"), "-lm", "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True, timeout=15)
