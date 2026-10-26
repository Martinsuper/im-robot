#!/usr/bin/env python3
"""One-time macOS migration; Piko itself never reads Keychain afterwards.

Quit Piko first. Secrets remain in process memory and the owner-only destination;
never send them to stdout, command arguments, logs, exports, or backups.
Old Keychain entries are deliberately left intact.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

KEYS = (
    ("apiKey", "com.duanluyao.imrobot", "model-api-key"),
    ("mimoTtsApiKey", "com.duanluyao.imrobot", "mimo-tts-api-key"),
    ("embeddingApiKey", "piko-knowledge-embeddings", "api-key"),
)


def read_keychain(service, account):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True, timeout=60, check=False,
    )
    if result.returncode == 44:  # errSecItemNotFound
        return None
    if result.returncode:
        raise RuntimeError("无法读取旧钥匙串密钥；未修改本机密钥文件。可授权后重试，或在设置中重新填写密钥。")
    return result.stdout.decode("utf-8").strip() or None


def migrate(path, read_secret=read_keychain):
    try:
        credentials = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(credentials, dict):
            raise ValueError()
        for field, _, _ in KEYS:
            if field in credentials and credentials[field] is not None and not isinstance(credentials[field], str):
                raise ValueError()
    except (ValueError, UnicodeError):
        raise RuntimeError("本机密钥文件格式错误；未覆盖原文件。") from None
    migrated = 0
    changed = False
    for field, service, account in KEYS:
        # Explicitly cleared keys (null/empty string) must not be resurrected.
        if field in credentials:
            continue
        credentials[field] = read_secret(service, account)
        migrated += bool(credentials[field])
        changed = True
    if not changed:
        path.chmod(0o600)
        return 0
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".credentials-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(credentials, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return migrated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path.home() / "Library/Application Support/com.duanluyao.imrobot")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("仅用于迁移旧版 macOS 钥匙串密钥。")
    running = subprocess.run(["pgrep", "-x", "im-robot"], capture_output=True, check=False)
    if running.returncode != 1:
        parser.error("请先完全退出 Piko，再运行迁移。")
    try:
        count = migrate(args.directory / "api-credentials.json")
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        print("密钥迁移失败；请检查目录权限及钥匙串授权后重试。", file=sys.stderr)
        return 1
    print(f"已迁移 {count} 项密钥；已有本机密钥及旧钥匙串记录均保留。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
