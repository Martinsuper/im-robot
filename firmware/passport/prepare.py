#!/usr/bin/env python3
"""Download the exact official BSP revision; does not connect to hardware."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
REV = "006c2279852e352a8433b2c21e5e09be2ca36f77"
dest = ROOT / "vendor" / "ai-passport"
created = not dest.exists()
if created:
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--no-checkout", "https://github.com/FoloToy/ai-passport.git", str(dest)], check=True)
current = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True)
if not created and current.returncode == 0 and current.stdout.strip() != REV:
    if subprocess.check_output(["git", "-C", str(dest), "status", "--porcelain"], text=True).strip():
        raise SystemExit("BSP has local changes; preserve them before changing revisions")
subprocess.run(["git", "-C", str(dest), "checkout", "--detach", REV], check=True)
print("Official BSP ready:", REV)
