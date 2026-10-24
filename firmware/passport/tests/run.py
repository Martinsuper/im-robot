#!/usr/bin/env python3
"""Exercise the real audio worker with pthread-backed RTOS/I2S doubles; no device access."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="piko-audio-tests-") as temp:
    binary = Path(temp) / "audio-tests"
    subprocess.run(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-pthread", f"-I{ROOT / 'tests/stubs'}", f"-I{ROOT / 'main'}", f"-I{ROOT / 'vendor/ai-passport/components/bsp/include'}", str(ROOT / "main/passport_audio.c"), str(ROOT / "tests/audio_host.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=15)

with tempfile.TemporaryDirectory(prefix="piko-confirm-tests-") as temp:
    binary = Path(temp) / "confirmation-tests"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", f"-I{ROOT / 'main'}", str(ROOT / "tests/confirmation_gate.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)

with tempfile.TemporaryDirectory(prefix="piko-portal-tests-") as temp:
    binary = Path(temp) / "portal-tests"
    subprocess.run(["cc", "-std=c11", f"-I{ROOT / 'main'}",
                    str(ROOT / "tests/portal_address.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)

with tempfile.TemporaryDirectory(prefix="piko-wifi-tests-") as temp:
    binary = Path(temp) / "wifi-tests"
    subprocess.run(["cc", "-std=c11", f"-I{ROOT / 'main'}",
                    str(ROOT / "tests/wifi_recovery.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)

with tempfile.TemporaryDirectory(prefix="piko-ui-tests-") as temp:
    binary = Path(temp) / "ui-tests"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", f"-I{ROOT / 'main'}", str(ROOT / "tests/ui_host.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)
