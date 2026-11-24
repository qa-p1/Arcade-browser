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

if (skip) test(`end-to-end: ${skip}`, { skip: true }, () => {});
