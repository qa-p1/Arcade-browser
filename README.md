# Arcade for the browser

Every Arcade app's abilities in Chrome, Edge, Brave, Vivaldi, Firefox, Zen and LibreWolf: right-click menus, on-page
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
- **The popup:** whether Arcade is connected, recent jobs, and a search over every action of every installed app.
  An action runs on typed text, this tab's address, a file picked there, or nothing (calculators, password
  generator). Its options form is drawn from its card. Actions can be pinned to the top of the menus.
- **From the keyboard:** Alt+Shift+X opens the popup (change it at chrome://extensions/shortcuts or Firefox's
  Manage Extension Shortcuts; Alt+Shift+A is taken by Chrome's "focus inactive dialogs"). In the address bar, type
  `a`, a space and what you want ("a qr", "a download"): the best match shows as you type and Enter opens its form
  for the current page.
- **Buttons on pages:** a Download button under videos on YouTube and Vimeo opens Box's downloader for the page. Which
  sites, where on the page (CSS selectors) and which action are data in the Arcade catalog's `browser` section, so a
  site that changes its layout is fixed there; the extension fetches it twice a day and keeps its own copy until
  then. Pointing at a picture shows an Arcade button with the image actions; a video gets the downloader. The
  buttons live in a closed shadow root (the page can't read which apps you have) and only real clicks count. When
  an action needs an engine its app installs (yt-dlp, FFmpeg), the button says so.
- **Finished downloads:** a notification naming what Arcade can do with the file (with buttons in Chromium); it
  opens the list, which runs the action on the downloaded file itself.
- **Settings:** the extension's own switches (buttons on sites, the button over pictures, download notices; all on
  by default), and Arcade's shared settings: where results go, pinned and hidden actions, the app chosen for each
  job. A Test connection button says whether Arcade answers (how many apps, which helper) and, if not, what to fix.
- **Not connected:** without Arcade Tools every menu is one "install Arcade Tools to connect…" entry, and the popup
  says what to do. The first install opens the same page.

Still to come (PLAN 4.7): live results in the menu for selected amounts and dates (needs a fast preview call in the
helper), and "send to phone" listing your devices (Clipboard's "Send to my devices" is already in the menus).

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

- **Chrome, Chromium, Edge, Brave, Vivaldi:** open the extensions page, turn on developer mode, "Load unpacked", and
  pick `dist/chromium`.
- **Firefox, Zen, LibreWolf:** open `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on…", and pick
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

## Releases

Push a tag `vX.Y.Z` matching `package.json`'s version. `.github/workflows/release.yml` checks, builds and publishes:

- `Arcade-browser-chromium-X.Y.Z.zip`, to load unpacked.
- The Firefox add-on, signed by Mozilla as an unlisted add-on when the repository has the owner's AMO API keys.
  Set them once from <https://addons.mozilla.org/developers/addon/api/key/>:

  ```bash
  gh secret set AMO_JWT_ISSUER --repo qa-p1/Arcade-browser
  ```

  ```bash
  gh secret set AMO_JWT_SECRET --repo qa-p1/Arcade-browser
  ```

  Without them, the release carries an unsigned zip instead (regular Firefox only keeps signed add-ons).
- The source zip that goes to Mozilla's reviewers, and `SHA256SUMS`.

A tag with a prerelease part (`v0.2.0-rc.1`) is published as a prerelease and never sent to Mozilla. Firefox
versions have no prerelease part, so an rc would use up that version number there.
