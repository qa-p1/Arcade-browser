#!/usr/bin/env python3
"""Copy the Arcade design kit from an Arcade Link checkout at the pinned tag.

    python3 scripts/sync-design.py --link ../Arcade-Link   # an existing checkout at the tag
    python3 scripts/sync-design.py                         # clones the tag
    python3 scripts/sync-design.py --check                 # the vendored files still match VENDORED.json

The tag is package.json's "arcade.link". The files land in design/ (the stylesheet, icons, format helpers, Inter,
the app glyphs, and the extension's icon from Arcade Tools' launcher set), and their hashes go to
design/VENDORED.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINK_URL = "https://github.com/qa-p1/Arcade-Link"
VENDORED = ROOT / "design/VENDORED.json"
# (source in Link, destination here); a trailing slash copies the folder's files.
FILES = [
    ("design/css/arcade.css", "design/arcade.css"),
    ("design/css/icons.ts", "design/icons.ts"),
    ("design/css/format.ts", "design/format.ts"),
    ("design/fonts/InterVariable.woff2", "design/fonts/InterVariable.woff2"),
    ("design/fonts/OFL.txt", "design/fonts/OFL.txt"),
    ("design/glyphs/", "design/glyphs/"),
    ("design/app-icons/tools/png/16.png", "design/icons/16.png"),
    ("design/app-icons/tools/png/32.png", "design/icons/32.png"),
    ("design/app-icons/tools/png/48.png", "design/icons/48.png"),
    ("design/app-icons/tools/png/128.png", "design/icons/128.png"),
]


def pinned_tag() -> str:
    return json.loads((ROOT / "package.json").read_text())["arcade"]["link"]


def git(link: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(link), *args], check=True, capture_output=True, text=True).stdout.strip()


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sync(link: Path, tag: str) -> None:
    commit = git(link, "rev-parse", "HEAD")
    tagged = git(link, "rev-parse", f"{tag}^{{commit}}")
    if commit != tagged:
        raise SystemExit(f"{link} is at {commit[:12]}, not {tag} ({tagged[:12]})")
    shutil.rmtree(ROOT / "design/glyphs", ignore_errors=True)
    hashes = {}
    for source, target in FILES:
        pairs = [(p, target + p.name) for p in sorted((link / source).iterdir()) if p.is_file()] if source.endswith("/") else [(link / source, target)]
        if not pairs:
            raise SystemExit(f"{source} is empty in the Link checkout")
        for path, dest in pairs:
            out = ROOT / dest
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, out)
            hashes[dest] = sha(out)
    VENDORED.write_text(json.dumps({"link": tag, "commit": commit, "files": hashes}, indent=2) + "\n")
    print(f"copied {len(hashes)} files from Link {tag}")


def check() -> int:
    record = json.loads(VENDORED.read_text())
    bad = []
    if record["link"] != pinned_tag():
        bad.append(f"VENDORED.json is from {record['link']}, package.json pins {pinned_tag()}")
    for dest, digest in record["files"].items():
        path = ROOT / dest
        if not path.is_file():
            bad.append(f"{dest} is missing")
        elif sha(path) != digest:
            bad.append(f"{dest} was changed by hand (run scripts/sync-design.py)")
    for line in bad:
        print(line, file=sys.stderr)
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--link", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    tag = pinned_tag()
    if args.link:
        sync(args.link.resolve(), tag)
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, LINK_URL, tmp], check=True)
        sync(Path(tmp), tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
