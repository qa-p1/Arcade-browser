// Firefox with the built add-on (dist/firefox) installed as a temporary add-on, the real helper reached through
// the host file it wrote in ~/.mozilla, and the real Arcade Box. Clicks go through the add-on's own handler, called
// from one of its pages.
//
//   FIREFOX  the Firefox binary (default: `firefox` on PATH)

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ADDON_UUID, launchFirefox, type Firefox } from './bidi.ts';
import { missing, startFleet, wait, type Fleet } from './fleet.ts';
import { FIREFOX_ADDON_ID, type Job } from '../../src/protocol.ts';
import type { MenuAction } from '../../src/menus.ts';

const dist = join(import.meta.dirname, '../../dist/firefox');
const binary = process.env.FIREFOX || 'firefox';
const hasFirefox = spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
const skip = missing() ?? (hasFirefox ? null : `no Firefox at ${binary} (set FIREFOX)`);
const base = `moz-extension://${ADDON_UUID}`;

function png(): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 4 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(20, 0);
  header.writeUInt32BE(10, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 10 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(60, 0x33)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const picture = png();
let fleet: Fleet;
let ff: Firefox;
let tab: string;
let server: Server;
let origin: string;

/** Evaluates `expr` with `bg` bound to the add-on's background page. */
function bg<T>(expr: string, f: Firefox = ff, context: string = tab): Promise<T> {
  return f.evaluate<T>(context, `(async () => { const bg = await browser.runtime.getBackgroundPage(); return ${expr}; })()`);
}

async function menus(f: Firefox = ff, context: string = tab): Promise<Record<string, MenuAction>> {
  return f.evaluate(context, `browser.storage.session.get('menus').then((r) => r.menus ?? {})`);
}

async function menuId(ref: string, kind: string): Promise<string> {
  const found = Object.entries(await menus()).find(([, a]) => a.kind === 'run' && a.ref === ref && a.context === kind);
  assert.ok(found, `${ref} isn't in the ${kind} menu`);
  return found[0];
}

async function click(id: string, info: Record<string, unknown>, tabInfo: Record<string, unknown> = {}): Promise<void> {
  await bg(`bg.arcade.handleClick(${JSON.stringify({ menuItemId: id, editable: false, ...info })}, ${JSON.stringify(tabInfo)}).then(() => true)`);
}

async function jobIds(): Promise<number[]> {
  return (await bg<Job[]>('bg.arcade.jobs()')).map((j) => j.id);
}

async function finished(ref: string, before: number[]): Promise<Job> {
  return wait(
    `${ref} to finish`,
    async () => (await bg<Job[]>('bg.arcade.jobs()')).find((j) => j.reference === ref && !before.includes(j.id) && ['done', 'failed', 'cancelled'].includes(j.status)),
    90_000,
  );
}

/** The form window a click opened: fills it with `script` and presses Run. */
async function runForm(script = ''): Promise<void> {
  const form = await wait(
    'the form window',
    async () => {
      const tree = await ff.send<{ contexts: { context: string; url: string }[] }>('browsingContext.getTree');
      return tree.contexts.find((c) => c.url.includes('/form.html'))?.context;
    },
    15_000,
  );
  await wait('the form', () => ff.evaluate<boolean>(form, `Boolean(document.getElementById('run'))`), 15_000);
  await ff.evaluate(form, `(() => { ${script}; document.getElementById('run').click(); return true; })()`);
  await wait(
    'the form to close',
    async () => {
      const tree = await ff.send<{ contexts: { url: string }[] }>('browsingContext.getTree');
      return !tree.contexts.some((c) => c.url.includes('/form.html'));
    },
    15_000,
  );
}

async function open(f: Firefox): Promise<string> {
  await f.send('webExtension.install', { extensionData: { type: 'path', path: dist } });
  // A first install opens the add-on's status page; BiDi may not navigate to add-on pages itself.
  return wait(
    'the add-on’s status page',
    async () => {
      const tree = await f.send<{ contexts: { context: string; url: string }[] }>('browsingContext.getTree');
      return tree.contexts.find((c) => c.url.startsWith(`${base}/popup.html`))?.context;
    },
    30_000,
  );
}

before(async () => {
  if (skip) return;
  fleet = await startFleet();
  server = createServer((req, res) => {
    if (req.url === '/cat.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(picture);
    } else if (req.url?.startsWith('/watch')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>A video</title><ytd-watch-metadata><div id="top-level-buttons-computed"><button>Like</button></div></ytd-watch-metadata>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Cats</title><img src="/cat.png">');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ff = await launchFirefox(binary, join(fleet.root, 'firefox-profile'), fleet.env, FIREFOX_ADDON_ID);
  tab = await open(ff);
  await wait('the menus', async () => Object.keys(await menus()).length > 20, 60_000);
});

after(async () => {
  await ff?.close();
  server?.close();
  await fleet?.stop();
});

test('Firefox: the add-on connects and its menus are Box’s offers', { skip: skip ?? false }, async () => {
  assert.equal((await bg<{ state: string }>('bg.arcade.state()')).state, 'connected');
  const table = Object.values(await menus());
  for (const kind of ['image', 'link', 'selection', 'page']) assert.ok(table.some((a) => 'context' in a && a.context === kind), `no ${kind} menu`);
});

test('Firefox: a one-click action on selected text', { skip: skip ?? false }, async () => {
  const before = await jobIds();
  const ref = 'arcade.box/box:arcade.text.clean#clean';
  await click(await menuId(ref, 'selection'), { selectionText: '  hello    world  \n\n\n x ', pageUrl: `${origin}/` });
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.texts?.[0], 'hello world\nx');
});

test('Firefox: an action with options, through its form', { skip: skip ?? false }, async () => {
  const before = await jobIds();
  const ref = 'arcade.box/box:arcade.text.structured';
  await click(await menuId(ref, 'selection'), { selectionText: '{"b": 1}', pageUrl: `${origin}/` });
  await runForm(`const s = document.getElementById('f-to'); s.value = 'yaml'; s.dispatchEvent(new Event('change'))`);
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.match(job.texts?.[0] ?? '', /^b: 1/);
});

test('Firefox: a picture on a page is fetched and hashed by Box', { skip: skip ?? false }, async () => {
  const access = await ff.evaluate<boolean>(tab, `browser.permissions.contains({ origins: ['<all_urls>'] })`);
  assert.ok(access, 'a temporary add-on has its host permission');
  const before = await jobIds();
  const ref = 'arcade.box/box:arcade.developer.hash';
  await click(await menuId(ref, 'image'), { srcUrl: `${origin}/cat.png`, pageUrl: `${origin}/` }, { url: `${origin}/`, title: 'Cats' });
  await runForm();
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const sha = createHash('sha256').update(picture).digest('hex');
  assert.ok((job.texts ?? []).some((t) => t.includes(sha)), JSON.stringify(job.texts));
});

test('Firefox: the popup searches every action and runs one on typed text', { skip: skip ?? false }, async () => {
  const ref = 'arcade.box/box:arcade.text.structured';
  const before = await jobIds();
  // A fresh copy of the page (the status page opened at install is this page); the old one is marked so the wait
  // can't see it.
  await ff.evaluate(tab, `(() => { window.__old = true; location.reload(); return true; })()`);
  await wait('the search field', () => ff.evaluate<boolean>(tab, `!window.__old && Boolean(document.getElementById('search'))`), 15_000);
  await ff.evaluate(tab, `(() => { const s = document.getElementById('search'); s.value = 'json yaml'; s.dispatchEvent(new Event('input')); return true; })()`);
  await wait('the result', () => ff.evaluate<boolean>(tab, `Boolean(document.querySelector('[data-ref="${ref}"] .link-row'))`), 15_000);
  await ff.evaluate(tab, `(() => { document.querySelector('[data-ref="${ref}"] .link-row').click(); return true; })()`);
  await wait('the form', () => ff.evaluate<boolean>(tab, `Boolean(document.getElementById('input-text'))`), 15_000);
  await ff.evaluate(
    tab,
    `(() => { const t = document.getElementById('input-text'); t.value = '{"a": 1}'; const s = document.getElementById('f-to'); s.value = 'yaml'; s.dispatchEvent(new Event('change')); document.getElementById('run').click(); return true; })()`,
  );
  const job = await finished(ref, before);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.match(job.texts?.[0] ?? '', /^a: 1/);
});

test('Firefox: without Arcade Tools there is one "install" entry', { skip: skip ?? false }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'arcade-browser-ffbare-'));
  const bare = await launchFirefox(binary, join(home, 'profile'), { ...fleet.env, HOME: home }, FIREFOX_ADDON_ID);
  try {
    const context = await open(bare);
    await wait('the connect entry', async () => Object.values(await menus(bare, context)).some((a) => a.kind === 'connect'), 30_000);
    assert.deepEqual(Object.values(await menus(bare, context)), [{ kind: 'connect' }]);
  } finally {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  }
});

if (skip) test(`Firefox end-to-end: ${skip}`, { skip: true }, () => {});

test('Firefox: a site’s Download button is on the page and a real click reaches the downloader', { skip: skip ?? false }, async () => {
  const D = 'arcade.box/box:arcade.web.downloader';
  const config = {
    sites: [{ id: 'tube', name: 'Tube', matches: ['http://127.0.0.1/*'], buttons: [{ id: 'download', label: 'Download', action: D, anchors: ['ytd-watch-metadata #top-level-buttons-computed'], position: 'append', path: '^/watch' }] }],
    hover: { minWidth: 120, minHeight: 80, exclude: [] },
  };
  await bg(`bg.arcade.setConfig(${JSON.stringify(config)}).then(() => { bg.arcade.resetPageResult(); return true; })`);
  const { context: page } = await ff.send<{ context: string }>('browsingContext.create', { type: 'tab' });
  await ff.send('browsingContext.navigate', { context: page, url: `${origin}/watch?v=abc`, wait: 'complete' });
  await wait('the button', () => ff.evaluate<boolean>(page, `Boolean(document.querySelector('#top-level-buttons-computed > arcade-ext'))`), 15_000);
  assert.equal(await ff.evaluate<boolean>(page, `document.querySelector('arcade-ext').shadowRoot === null`), true);
  const box = await ff.evaluate<{ x: number; y: number }>(page, `(() => { const r = document.querySelector('arcade-ext').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await ff.send('input.performActions', {
    context: page,
    actions: [{ type: 'pointer', id: 'mouse', actions: [{ type: 'pointerMove', x: box.x, y: box.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }],
  });
  const result = await wait('the button’s answer', () => bg<{ form?: true; needs?: string } | null>('bg.arcade.lastPageResult()'), 15_000);
  if (result.needs) assert.match(result.needs, /yt-dlp/);
  else assert.equal(result.form, true, JSON.stringify(result));
  await ff.send('browsingContext.close', { context: page });
});
