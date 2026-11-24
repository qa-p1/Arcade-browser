#!/usr/bin/env python3
"""The release page's text: how to install each package.

    scripts/release-notes.py VERSION signed|unsigned
"""
import sys

version, firefox = sys.argv[1], sys.argv[2]

chromium = f"""### Chrome, Chromium, Edge, Brave, Vivaldi

1. Download `Arcade-browser-chromium-{version}.zip` and unzip it into a folder you'll keep.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Choose **Load unpacked** and pick the folder.

To update, unzip the new version over the same folder and press the extension's reload button."""

if firefox == "signed":
    gecko = f"""### Firefox, Zen, LibreWolf

Open `Arcade-browser-firefox-{version}.xpi` in the browser (drag it onto a window, or open the downloaded file)
and confirm. Mozilla signed it, so it stays installed and updates when you open a newer one."""
else:
    gecko = f"""### Firefox, Zen, LibreWolf

This release isn't signed by Mozilla yet. Regular Firefox only keeps signed add-ons, so either:

- load `Arcade-browser-firefox-{version}-unsigned.zip` in `about:debugging` → **This Firefox** →
  **Load Temporary Add-on** (it's removed when the browser quits), or
- in Firefox Developer Edition or Nightly, set `xpinstall.signatures.required` to `false` in `about:config`
  and open the zip as an add-on."""

print(f"""Arcade's actions on images, links, videos, selected text, pages and downloads, from the Arcade apps on your
computer. It needs **Arcade Tools** 1.1 or later, which connects the browser to your apps.

{chromium}

{gecko}

The extension asks for access to every site so it can hand pictures and pages to your apps and put its buttons on
pages. It sends nothing anywhere except to the Arcade apps on this computer; the only thing it fetches for itself is
the Arcade catalog (where the buttons go on each site).

`SHA256SUMS` lists each file's checksum.""")
