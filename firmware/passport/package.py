#!/usr/bin/env python3
"""Verify and package segmented firmware. Never connects to or writes hardware."""
from pathlib import Path
import hashlib
import json
import struct
import zipfile

root = Path(__file__).resolve().parent
build = root / "build"
args = json.loads((build / "flasher_args.json").read_text())
expected = {0: "bootloader/bootloader.bin", 0x8000: "partition_table/partition-table.bin", 0x10000: "Piko-Passport.bin"}
actual = {int(offset, 0): path for offset, path in args["flash_files"].items()}
if actual != expected or args["flash_settings"]["flash_size"] != "8MB":
    raise SystemExit("Unexpected flash layout or capacity; refusing to package")
segments = []
end = 0
for offset, relative in sorted(actual.items()):
    path = build / relative
    data = path.read_bytes()
    if not data or offset < end or (offset < 0x35A000 and offset + len(data) > 0x356000):
        raise SystemExit(f"Invalid segment or device identity overlap: {relative}")
    if offset == 0x10000:
        if len(data) > 0x340000 or data[0] != 0xE9 or struct.unpack_from("<H", data, 12)[0] != 5:
            raise SystemExit("Unexpected application size or ESP32-C3 image header")
    end = offset + len(data)
    segments.append({"offset": hex(offset), "file": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
manifest = {"version": "piko-0.8.0", "chip": "esp32c3", "flashSize": "8MB", "segments": segments,
            "preservedIdentityRange": ["0x356000", "0x35a000"], "deviceTested": False}
archive = build / "piko-passport-0.8.0.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
    for segment, relative in zip(segments, (relative for _, relative in sorted(actual.items()))):
        output.write(build / relative, segment["file"])
    output.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
    output.writestr("README.txt", "Piko Passport 0.8.0, ESP32-C3 / 8MB. Not device-tested.\n"
                    "Segmented images only: use the offsets in manifest.json.\n"
                    "Do not erase flash or write a merged image. Confirm the existing partition layout,\n"
                    "back up existing firmware/data, and obtain the user's flashing approval first.\n"
                    "This firmware replaces the current application and partition table.\n")
print(archive)
for segment in segments:
    print(f"{segment['offset']} {segment['file']}: {segment['bytes']} bytes, SHA256 {segment['sha256']}")
