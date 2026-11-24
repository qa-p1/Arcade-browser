#!/usr/bin/env python3
"""Download the released Arcade apps in test/e2e/apps.json, check their SHA-256, and unpack the helper from
Arcade Tools. Prints the environment the end-to-end tests read (ARCADE_HELPER, ARCADE_BOX). With --firefox, also
the pinned Firefox from Mozilla's archive (FIREFOX), so the runner image's own Firefox never decides a result.

    python3 scripts/ci/fetch-apps.py OUT_DIR [--firefox] >> "$GITHUB_ENV"
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def download(url: str, dest: Path, sha256: str) -> None:
    if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
        return
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
            break
        except OSError as error:
            print(f"download attempt {attempt} of {url} failed: {error}", file=sys.stderr)
            if attempt == 4:
                raise
            time.sleep(10 * attempt)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != sha256:
        dest.unlink()
        raise SystemExit(f"{dest.name}: SHA-256 {digest}, expected {sha256}")
    dest.chmod(0o755)


def firefox(out: Path, pin: dict) -> Path:
    archive = out / pin["url"].rsplit("/", 1)[1]
    download(pin["url"], archive, pin["sha256"])
    folder = out / f"firefox-{pin['version']}"
    binary = folder / "firefox" / "firefox"
    if not binary.is_file():
        folder.mkdir(exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(folder, filter="tar")
    if not binary.is_file():
        raise SystemExit(f"{archive.name} has no firefox/firefox")
    return binary


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    apps = json.loads((ROOT / "test/e2e/apps.json").read_text())
    paths = {}
    for name in ("tools", "box"):
        app = apps[name]
        dest = out / app["asset"]
        download(f"https://github.com/{app['repo']}/releases/download/{app['tag']}/{app['asset']}", dest, app["sha256"])
        paths[name] = dest
    # The helper ships inside Arcade Tools' package.
    unpacked = out / "tools"
    if not (unpacked / "squashfs-root/usr/bin/arcade-helper").is_file():
        unpacked.mkdir(exist_ok=True)
        subprocess.run([str(paths["tools"]), "--appimage-extract"], cwd=unpacked, check=True, stdout=subprocess.DEVNULL)
    helper = unpacked / "squashfs-root/usr/bin/arcade-helper"
    if not helper.is_file():
        raise SystemExit("Arcade Tools' package has no usr/bin/arcade-helper")
    print(f"ARCADE_HELPER={helper}")
    print(f"ARCADE_BOX={paths['box']}")
    if "--firefox" in sys.argv[2:]:
        print(f"FIREFOX={firefox(out, apps['firefox'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
