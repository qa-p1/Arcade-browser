# Arcade for the browser

Every Arcade app's abilities in Chrome, Edge, Brave, Vivaldi, Firefox and Zen: right-click menus, on-page
buttons, a search-everything popup and download notifications. The extension knows no app's actions itself; each item
is an offer from the Arcade helper that Arcade Tools installs, so new apps and actions appear without an extension
update.

Work in progress (Arcade everywhere, stage 5). The plan is in
[Arcade-catalog › dev/everywhere/PLAN.md](https://github.com/qa-p1/Arcade-catalog/blob/main/dev/everywhere/PLAN.md),
section 4.7.

## What works now

- **Right-click menus** on an image, a link, a link to a PDF, a video, audio, selected text, the page and a PDF page.
  Each is filled from the helper's offers for that kind of thing: pinned actions, your defaults and the strongest
  matches first, the rest in their groups ("Images ▸ …"), other apps' ways of doing the same job under "Other apps",
  and "More…" last. Actions that need an engine show greyed out with the reason; an action from an app you don't
  have offers to install it.
- **Running:** one-click actions run straight away; the others open a small window with the app's own options form
  (drawn from its card, remembering your last choice). Pictures, PDFs and media are fetched by the extension with the
  page's cookies and handed to the helper as bytes (up to 48 MB); links, pages and selections go as text.
- **Jobs:** a badge while something runs, a notification when it finishes ("Saved cat.webp", the text result, or why
  it failed), and the toolbar popup lists recent jobs with their results (copy a text result, cancel, clear).
- **Not connected:** without Arcade Tools every menu is one "install Arcade Tools to connect…" entry, and the popup
  says what to do. The first install opens the same page.

Still to come (PLAN 4.7): the popup's search over every action, settings, on-page buttons (YouTube download, image
hover) from the catalog's `browser.sites`, live results for selected amounts, download notifications, send to
phone, and the release workflow (zip and signed `.xpi`).

## How it talks to Arcade

The extension opens a native messaging port to `dev.arcade.helper`, the Arcade helper from Arcade Link
(`crates/arcade-helper`), which Arcade Tools installs and registers with every browser it finds. The helper answers
only this extension: Chromium-family browsers know it by the ID `dbghmpdffbagedciechjkmcmjahcdmad` (fixed by the
`key` in the Chromium manifest, so an unpacked copy has the same ID everywhere), Firefox-family browsers by
`{77b33901-3817-4946-8df0-1914a2850188}`. The methods are listed in `src/protocol.ts` and in the helper's
`bridge.rs`.

## Build and try it

Node 22.18 or newer.

```bash
npm ci
```

```bash
npm run build
```

This writes `dist/chromium` and `dist/firefox`.

- **Chrome, Edge, Brave, Vivaldi:** open the extensions page, turn on developer mode, "Load unpacked", and
  pick `dist/chromium`.
- **Firefox, Zen:** open `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on…", and pick
  `dist/firefox/manifest.json`.

Arcade Tools 1.1 or newer must be installed and opened once, so the helper's host files exist.

## Tests

```bash
npm run check
```

Types, unit tests (`test/unit`, on the real helper answers in `test/fixtures`), both builds, and the design kit
check.

```bash
npm run e2e
```

The end-to-end tests run the built extension in real Chromium (Playwright) and real Firefox (its own WebDriver BiDi
server; no geckodriver), in a throwaway home with the released Arcade Box running and the host files the released
helper writes itself. They need `ARCADE_HELPER` (the `arcade-helper` binary from Arcade Tools' package) and
`ARCADE_BOX` (Box's AppImage), and `FIREFOX` when Firefox isn't on the PATH; `scripts/ci/fetch-apps.py DIR`
downloads the versions pinned in `test/e2e/apps.json` and prints those variables. Without them the tests are skipped.
CI runs both browsers on every pull request.

## Design

The pages use the Arcade design kit from Arcade Link at the tag in `package.json` (`arcade.link`):
`scripts/sync-design.py` copies it into `design/` and records hashes in `design/VENDORED.json`, which
`scripts/sync-design.py --check` verifies.

Licensed under either of [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option.
