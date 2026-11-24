// Chromium with the built extension (dist/chromium), the real helper reached through the host file it wrote
// itself, and the real Arcade Box. Browser menus can't be opened by automation, so clicks go through the
// extension's own handler (`arcade.handleClick`), exactly as the browser calls it.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { missing, startFleet, wait, type Fleet } from './fleet.ts';
import { CHROME_EXTENSION_ID, type Job } from '../../src/protocol.ts';
import type { MenuAction } from '../../src/menus.ts';

const dist = join(import.meta.dirname, '../../dist/chromium');
const skip = missing();

/** A small real PNG. */
function png(width = 32, height = 24): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(kind, 4, 'latin1');
    data.copy(out, 8);
    let c = ~0;
    for (const b of out.subarray(4, 8 + data.length)) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    out.writeUInt32BE(~c >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const picture = png();
let fleet: Fleet;
let context: BrowserContext;
let worker: Worker;
let server: Server;
let origin: string;

async function launch(profile: string, env: Record<string, string>): Promise<{ context: BrowserContext; worker: Worker }> {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    env,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }));
  return { context: ctx, worker: sw };
}

async function menus(w: Worker): Promise<Record<string, MenuAction>> {
  return w.evaluate(async () => ((await chrome.storage.session.get('menus')) as { menus?: Record<string, MenuAction> }).menus ?? {});
}

/** The menu id of `ref` under `context`. */
async function menuId(ref: string, kind: string): Promise<string> {
  const table = await menus(worker);
  const found = Object.entries(table).find(([, a]) => a.kind === 'run' && a.ref === ref && a.context === kind);
  assert.ok(found, `${ref} isn't in the ${kind} menu: ${JSON.stringify(Object.values(table).filter((a) => a.kind === 'run' && a.context === kind).map((a) => (a as { ref: string }).ref))}`);
  return found[0];
}

async function click(id: string, info: Record<string, unknown>, tab: Record<string, unknown> = {}): Promise<void> {
  await worker.evaluate(
    ([id, info, tab]) => (globalThis as unknown as { arcade: { handleClick: (i: unknown, t: unknown) => Promise<void> } }).arcade.handleClick({ menuItemId: id, editable: false, ...info }, tab),
    [id, info, tab] as const,
  );
}

async function jobs(): Promise<Job[]> {
  return worker.evaluate(() => (globalThis as unknown as { arcade: { jobs: () => Job[] } }).arcade.jobs());
}

/** The finished job for `ref` that wasn't there before. */
async function finished(ref: string, before: number[]): Promise<Job> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const job = (await jobs()).find((j) => j.reference === ref && !before.includes(j.id) && ['done', 'failed', 'cancelled'].includes(j.status));
    if (job) return job;
    assert.ok(Date.now() < deadline, `${ref} didn't finish: ${JSON.stringify(await jobs())}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function ids(): Promise<number[]> {
  return (await jobs()).map((j) => j.id);
}

/** Opens the form a click opened, fills it and runs it. */
async function runForm(fillIn: (page: Page) => Promise<void> = async () => {}): Promise<void> {
  const page = context.pages().find((p) => p.url().includes('/form.html')) ?? (await context.waitForEvent('page', { predicate: (p) => p.url().includes('/form.html'), timeout: 15_000 }));
  await page.waitForSelector('#run');
  await fillIn(page);
  await page.click('#run');
  await page.waitForEvent('close', { timeout: 15_000 });
}

before(async () => {
  if (skip) return;
  fleet = await startFleet();
  server = createServer((req, res) => {
    if (req.url === '/cat.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(picture);
    } else if (req.url === '/report.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="report.png"' });
      res.end(picture);
    } else if (req.url?.startsWith('/watch')) {
      // Laid out as a video site's page is: the catalog's anchor for the button, under the video.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>A video</title><video width="480" height="270"></video><ytd-watch-metadata><div id="top-level-buttons-computed"><button>Like</button></div></ytd-watch-metadata>');
    } else if (req.url === '/gallery') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Gallery</title><body style="margin:0"><img id="big" src="/cat.png" width="400" height="300"><img id="small" src="/cat.png" width="40" height="30"></body>');
    } else if (req.url === '/clip') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Clip</title><body style="margin:0"><video id="v" src="/clip.mp4" width="480" height="270"></video></body>');
    } else if (req.url === '/files') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Files</title><a id="get" href="/report.png" download>Report</a>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Cats</title><p>Hello <b>world</b></p><img src="/cat.png">');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ context, worker } = await launch(fleet.chromiumProfile, fleet.env));
  // The menus are built on install; wait for the helper's answers.
  await wait('the menus', async () => Object.keys(await menus(worker)).length > 20, 60_000);
});

after(async () => {
  await context?.close();
  server?.close();
  await fleet?.stop();
});

test('the extension has the ID the helper answers, and connects', { skip: skip ?? false }, async () => {
  assert.equal(new URL(worker.url()).host, CHROME_EXTENSION_ID);
  const state = await worker.evaluate(() => (globalThis as unknown as { arcade: { state: () => { state: string } } }).arcade.state());
  assert.equal(state.state, 'connected');
});

test('the menus are Box’s offers for each kind of thing', { skip: skip ?? false }, async () => {
  const table = Object.values(await menus(worker));
  const kinds = new Set<string>(table.map((a) => ('context' in a ? a.context : a.kind)));
  for (const kind of ['image', 'link', 'selection', 'page']) assert.ok(kinds.has(kind), `no ${kind} menu`);
  const clean = table.find((a) => a.kind === 'run' && a.ref === 'arcade.box/box:arcade.text.clean#clean');
  assert.ok(clean && clean.kind === 'run' && clean.oneClick && clean.context === 'selection');
  assert.ok(table.some((a) => a.kind === 'more'));
});

test('a one-click action on selected text runs in Box and returns its result', { skip: skip ?? false }, async () => {
  const before = await ids();
  const ref = 'arcade.box/box:arcade.text.clean#clean';
  await click(await menuId(ref, 'selection'), { selectionText: '  hello    world  \n\n\n x ', pageUrl: `${origin}/` }, { url: `${origin}/`, title: 'Cats' });
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.origin, 'browser');
  assert.equal(job.texts?.[0], 'hello world\nx');
});

test('an action with options opens its form; the values chosen are used and remembered', { skip: skip ?? false }, async () => {
  const before = await ids();
  const ref = 'arcade.box/box:arcade.text.structured';
  await click(await menuId(ref, 'selection'), { selectionText: '{"b": 1, "a": [1, 2]}', pageUrl: `${origin}/` });
  await runForm(async (page) => {
    assert.equal(await page.textContent('.t-title-sm'), 'JSON / YAML / TOML / XML');
    await page.selectOption('#f-to', 'yaml');
  });
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.match(job.texts?.[0] ?? '', /^b: 1\na:\n\s*- 1\n\s*- 2/m);
  const remembered = await worker.evaluate((r) => chrome.storage.local.get(`values:${r}`), ref);
  assert.equal((remembered[`values:${ref}`] as Record<string, unknown>).to, 'yaml');
});

test('a picture on a page is fetched, handed over as bytes and hashed by Box', { skip: skip ?? false }, async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const before = await ids();
  const ref = 'arcade.box/box:arcade.developer.hash';
  await click(await menuId(ref, 'image'), { srcUrl: `${origin}/cat.png`, pageUrl: `${origin}/`, mediaType: 'image' }, { url: `${origin}/`, title: 'Cats' });
  await runForm();
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const sha = createHash('sha256').update(picture).digest('hex');
  assert.ok((job.texts ?? []).some((t) => t.includes(sha)), `no ${sha} in ${JSON.stringify(job.texts)}`);
  await page.close();
});

test('the popup shows the connection and the results', { skip: skip ?? false }, async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html`);
  await page.waitForSelector('#state');
  assert.match((await page.textContent('#state')) ?? '', /Connected · 1 app/);
  await page.waitForSelector('[data-status="done"]');
  assert.ok(((await page.textContent('#jobs')) ?? '').includes('hello world'));
  await page.close();
});

test('without Arcade Tools, every menu is one "install" entry and the popup says how to connect', { skip: skip ?? false }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'arcade-browser-bare-'));
  const bare = await launch(profile, { ...fleet.env, HOME: profile, XDG_CONFIG_HOME: profile });
  try {
    await wait('the connect entry', async () => Object.values(await menus(bare.worker)).some((a) => a.kind === 'connect'), 30_000);
    const table = Object.values(await menus(bare.worker));
    assert.deepEqual(table, [{ kind: 'connect' }]);
    const page = await bare.context.newPage();
    await page.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html`);
    await page.waitForSelector('#connect');
    assert.match((await page.textContent('#state')) ?? '', /Not connected/);
  } finally {
    await bare.context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function popup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html`);
  await page.waitForSelector('#search');
  return page;
}

test('the popup searches every action and runs one on typed text', { skip: skip ?? false }, async () => {
  const page = await popup();
  await page.fill('#search', 'json yaml');
  const ref = 'arcade.box/box:arcade.text.structured';
  await page.click(`[data-ref="${ref}"] .link-row`);
  await page.fill('#input-text', '{"a": [1, 2]}');
  await page.selectOption('#f-to', 'yaml');
  const before = await ids();
  await page.click('#run');
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.match(job.texts?.[0] ?? '', /^a:\n\s*- 1\n\s*- 2/);
  await page.waitForSelector('#search');
  await page.close();
});

test('the popup runs an action on a file picked there', { skip: skip ?? false }, async () => {
  const page = await popup();
  await page.fill('#search', 'images to pdf');
  const ref = 'arcade.box/box:arcade.pdf.images-to-pdf';
  await page.click(`[data-ref="${ref}"] .link-row`);
  await page.setInputFiles('#input-file', { name: 'cat.png', mimeType: 'image/png', buffer: picture });
  const before = await ids();
  await page.click('#run');
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.match(job.files?.[0] ?? '', /\.pdf$/);
  await page.close();
});

test('an action that needs no input runs, or says the helper is too old for it', { skip: skip ?? false }, async () => {
  const page = await popup();
  await page.fill('#search', 'password generator');
  const ref = 'arcade.box/box:arcade.security.password';
  await page.click(`[data-ref="${ref}"] .link-row`);
  await page.waitForSelector('#run');
  assert.equal(await page.$('#input-text, #input-url, #input-file'), null, 'no input to give');
  const before = await ids();
  await page.click('#run');
  const outcome = await wait(
    'a result or an explanation',
    async () => {
      const error = (await page.textContent('.error').catch(() => null)) ?? '';
      if (error) return { error };
      const job = (await jobs()).find((j) => j.reference === ref && !before.includes(j.id) && j.status === 'done');
      return job ? { job } : null;
    },
    60_000,
  );
  if ('error' in outcome) assert.match(outcome.error ?? '', /can’t run actions that need no input yet/);
  else assert.ok((outcome.job.texts ?? []).length > 0);
  await page.close();
});

test('pinning from the popup puts the action first in the menus; settings unpin it', { skip: skip ?? false }, async () => {
  const ref = 'arcade.box/box:arcade.text.statistics';
  const page = await popup();
  await page.fill('#search', 'statistics');
  await page.click(`[data-ref="${ref}"] .row-end button`);
  await page.waitForSelector(`[data-ref="${ref}"] .row-end button.active`);
  await page.close();
  const first = async () => {
    const table = await menus(worker);
    const selection = Object.entries(table).filter(([, a]) => a.kind === 'run' && a.context === 'selection');
    selection.sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
    return (selection[0]?.[1] as { ref?: string } | undefined)?.ref;
  };
  await wait('the pinned action on top', async () => (await first()) === ref, 30_000);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${CHROME_EXTENSION_ID}/options.html`);
  await settings.waitForSelector(`#pinned [data-ref="${ref}"]`);
  assert.match((await settings.textContent(`#pinned [data-ref="${ref}"]`)) ?? '', /Text Statistics/);
  await settings.click(`#pinned [data-ref="${ref}"] button`);
  await settings.waitForSelector(`#pinned [data-ref="${ref}"]`, { state: 'detached' });
  await wait('the menus without the pin', async () => (await first()) !== ref, 30_000);
  await settings.close();
});

if (skip) test(`end-to-end: ${skip}`, { skip: true }, () => {});

// ---------------------------------------------------------------------------------------------------------------
// Buttons on pages and finished downloads

const DOWNLOADER = 'arcade.box/box:arcade.web.downloader';

/** The catalog's section, pointed at this test's server. */
async function useConfig(): Promise<void> {
  const config = {
    sites: [
      {
        id: 'tube',
        name: 'Tube',
        matches: ['http://127.0.0.1/*'],
        buttons: [{ id: 'download', label: 'Download', action: DOWNLOADER, anchors: ['ytd-watch-metadata #top-level-buttons-computed'], position: 'append', path: '^/watch' }],
      },
    ],
    hover: { minWidth: 120, minHeight: 80, video: { label: 'Download', action: DOWNLOADER }, exclude: [] },
  };
  await worker.evaluate((c) => (globalThis as unknown as { arcade: { setConfig: (c: unknown) => Promise<void> } }).arcade.setConfig(c), config);
}

/** After a downloader button: its form for `subject`, or (Box has no yt-dlp in the test home) the reason why not. */
async function downloaderOpened(subject?: string): Promise<void> {
  const result = await wait(
    'the downloader button’s answer',
    () => worker.evaluate(() => (globalThis as unknown as { arcade: { lastPageResult: () => unknown } }).arcade.lastPageResult()) as Promise<{ form?: true; needs?: string } | null>,
    15_000,
  );
  if (result.needs) {
    assert.match(result.needs, /yt-dlp/);
    return;
  }
  assert.equal(result.form, true, JSON.stringify(result));
  const page = context.pages().find((p) => p.url().includes('/form.html')) ?? (await context.waitForEvent('page', { predicate: (p) => p.url().includes('/form.html'), timeout: 15_000 }));
  await page.waitForSelector('#run');
  assert.equal(await page.textContent('.t-title-sm'), 'Media Downloader');
  if (subject) assert.equal(await page.textContent('.subject'), subject);
  await page.close();
}

async function resetPageResult(): Promise<void> {
  await worker.evaluate(() => {
    (globalThis as unknown as { arcade: { resetPageResult: () => void } }).arcade.resetPageResult();
  });
}

test('a site’s Download button sits where the catalog says and opens the downloader for the page', { skip: skip ?? false }, async () => {
  await useConfig();
  const page = await context.newPage();
  await page.goto(`${origin}/watch?v=abc`);
  const host = page.locator('#top-level-buttons-computed > arcade-ext[data-arcade="site-download"]');
  await host.waitFor({ timeout: 15_000 });
  // The page can't look inside it.
  assert.equal(await page.evaluate(() => document.querySelector('arcade-ext')!.shadowRoot), null);
  // A click from the page's own script is not a click.
  await resetPageResult();
  await page.evaluate(() => (document.querySelector('arcade-ext') as HTMLElement).click());
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await worker.evaluate(() => (globalThis as unknown as { arcade: { lastPageResult: () => unknown } }).arcade.lastPageResult()), null);
  await host.click();
  await downloaderOpened(`${origin}/watch?v=abc`);
  // Off a watch page (the site changed page without loading one), the button goes.
  await page.evaluate(() => {
    history.pushState({}, '', '/feed');
    document.body.append(document.createElement('div'));
  });
  await host.waitFor({ state: 'detached', timeout: 5_000 });
  await page.close();
});

test('the button over a picture lists the image actions and runs the one chosen', { skip: skip ?? false }, async () => {
  await useConfig();
  const offers = await worker.evaluate(() => (globalThis as unknown as { arcade: { imageOffers: () => Promise<{ ref: string; oneClick: boolean }[]> } }).arcade.imageOffers());
  const index = offers.findIndex((o) => o.ref === 'arcade.box/box:arcade.developer.hash' || o.ref === 'arcade.box/box:arcade.image.convert#png');
  assert.ok(index >= 0, `neither hashing nor PNG among ${JSON.stringify(offers)}`);
  const chosen = offers[index]!;
  const page = await context.newPage();
  await page.goto(`${origin}/gallery`);
  const hover = page.locator('arcade-ext[data-arcade="hover"]');
  // Too small a picture gets no button.
  await page.mouse.move(20, 300 + 15);
  await page.mouse.move(400 + 20, 315);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await hover.isVisible().catch(() => false), false);
  await page.mouse.move(200, 150);
  await hover.waitFor({ state: 'visible', timeout: 10_000 });
  const before = await ids();
  await hover.click();
  // The list opens on its first entry; arrow keys move, Enter chooses.
  await new Promise((r) => setTimeout(r, 1_000));
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  if (!chosen.oneClick) await runForm();
  const job = await finished(chosen.ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  if (chosen.ref.endsWith('hash')) {
    const sha = createHash('sha256').update(picture).digest('hex');
    assert.ok((job.texts ?? []).some((t) => t.includes(sha)), `no ${sha} in ${JSON.stringify(job.texts)}`);
  }
  await page.close();
});

test('a video gets a Download button that opens the downloader', { skip: skip ?? false }, async () => {
  await useConfig();
  const page = await context.newPage();
  await page.goto(`${origin}/clip`);
  const hover = page.locator('arcade-ext[data-arcade="hover"]');
  await page.mouse.move(240, 135);
  await hover.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal((await hover.textContent()) ?? '', '', 'the label lives in the closed shadow root');
  await resetPageResult();
  await hover.click();
  await downloaderOpened();
  await page.close();
});

test('a finished download lists what Arcade can do with the file and runs it there', { skip: skip ?? false }, async () => {
  const sessionKeys = () => worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('download:')));
  const known = await sessionKeys();
  const page = await context.newPage();
  await page.goto(`${origin}/files`);
  await page.click('#get');
  const key = await wait('the download’s notice', async () => (await sessionKeys()).find((k) => !known.includes(k)), 30_000);
  const pending = await worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k], key) as { offers: { ref: string; oneClick: boolean; title: string }[] };
  assert.ok(pending.offers.length > 0);
  const list = await context.newPage();
  await list.goto(`chrome-extension://${CHROME_EXTENSION_ID}/download.html#${key.slice('download:'.length)}`);
  await list.waitForSelector('[data-ref]');
  const hash = pending.offers.find((o) => o.ref === 'arcade.box/box:arcade.developer.hash');
  assert.ok(hash, `no hashing among ${JSON.stringify(pending.offers.map((o) => o.ref))}`);
  const before = await ids();
  await list.click(`[data-ref="${hash.ref}"]`);
  await list.waitForSelector('#run');
  await list.click('#run');
  const job = await finished(hash.ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const sha = createHash('sha256').update(picture).digest('hex');
  assert.ok((job.texts ?? []).some((t) => t.includes(sha)), `no ${sha} in ${JSON.stringify(job.texts)}`);
  await page.close();
  if (!list.isClosed()) await list.close();
});
