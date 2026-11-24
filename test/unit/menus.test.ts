import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTree, connectTree, CONTEXTS, merge, QUICK_LIMIT, type MenuNode } from '../../src/menus.ts';
import type { Offer } from '../../src/protocol.ts';

const box = JSON.parse(readFileSync(new URL('../fixtures/box.json', import.meta.url), 'utf8')) as Record<string, Offer[]>;

function offer(ref: string, extra: Partial<Offer> = {}): Offer {
  const [app, action] = ref.split('/') as [string, string];
  return { app, action, title: action, rank: 30, enabled: true, appName: app, ref, ...extra };
}

function titles(nodes: MenuNode[]): string[] {
  return nodes.map((n) => (n.separator ? '---' : n.children ? `${n.title} ▸` : n.title));
}

test('every kind of thing has a menu, each asking for real surfaces', () => {
  const kinds = CONTEXTS.map((c) => c.kind);
  assert.deepEqual(kinds, ['image', 'link', 'pdf-link', 'video', 'audio', 'selection', 'page', 'pdf']);
  for (const c of CONTEXTS) {
    assert.ok(c.queries.length > 0, c.kind);
    for (const q of c.queries) assert.match(q.surface, /^browser-/);
  }
  assert.equal(CONTEXTS.find((c) => c.kind === 'selection')!.title.includes('%s'), true);
});

test('a short answer is one flat list with More… last', () => {
  const tree = buildTree('link', merge([box.link!]));
  assert.equal(tree.filter((n) => n.children).length, 0);
  assert.deepEqual(titles(tree).slice(-2), ['---', 'More…']);
  // Everything Box offered is there, enabled ones first.
  const entries = tree.filter((n) => !n.separator && n.action?.kind !== 'more');
  assert.equal(entries.length, box.link!.length);
  const firstDisabled = entries.findIndex((n) => !n.enabled);
  assert.ok(entries.slice(firstDisabled).every((n) => !n.enabled), 'disabled entries sink');
  const downloader = entries.find((n) => n.title.startsWith('Media Downloader'))!;
  assert.equal(downloader.title, "Media Downloader (yt-dlp isn't installed)");
  assert.equal(downloader.enabled, false);
});

test('a long answer puts the strongest first and groups the rest', () => {
  const tree = buildTree('selection', merge([box.selection!]));
  const t = titles(tree);
  // Box's one-click presets (rank 70) and "More in Arcade Box…" (65) lead.
  assert.deepEqual(t.slice(0, 3), ['Clean text', 'Format JSON', 'More in Arcade Box…']);
  assert.ok(t.includes('Text & Data ▸'));
  assert.ok(t.includes('Developer ▸'));
  const groups = tree.filter((n) => n.children).map((n) => n.title);
  assert.deepEqual(groups, [...groups].sort((a, b) => a.localeCompare(b)), 'groups in order');
  const clean = tree[0]!;
  assert.deepEqual(clean.action, {
    kind: 'run',
    context: 'selection',
    query: 0,
    ref: 'arcade.box/box:arcade.text.clean#clean',
    title: 'Clean text',
    appName: 'Arcade Box',
    oneClick: true,
  });
  const json = tree.find((n) => n.title === 'Text & Data')!.children!.find((n) => n.title === 'JSON / YAML / TOML / XML')!;
  assert.equal(json.action?.kind === 'run' && json.action.oneClick, false, 'a form action opens its form');
});

test('pictures: disabled presets never take the quick spots', () => {
  const tree = buildTree('image', merge([box.image!]));
  const quick = tree.slice(0, tree.findIndex((n) => n.separator));
  assert.ok(quick.every((n) => n.enabled));
  const images = tree.find((n) => n.title === 'Images')!;
  assert.ok(images.children!.some((n) => n.title === "Convert to WebP (libvips isn't installed)" && !n.enabled));
});

test('pinned and default actions come first; other apps go last', () => {
  const offers = [
    ...Array.from({ length: 12 }, (_, i) => offer(`arcade.box/t${i}`, { group: i % 2 ? 'B' : 'A' })),
    offer('arcade.lens/read', { title: 'Read text', preferred: true, job: 'image.read-text' }),
    offer('arcade.box/ocr', { title: 'Box OCR', other: true, job: 'image.read-text', rank: 80 }),
    offer('arcade.box/pinned', { title: 'Pinned one', pinned: true }),
  ];
  const t = titles(buildTree('image', merge([offers])));
  assert.deepEqual(t.slice(0, 3), ['Pinned one', 'Read text', '---']);
  assert.deepEqual(t.slice(-4), ['B ▸', 'Other apps ▸', '---', 'More…']);
});

test('the quick list is capped', () => {
  const offers = Array.from({ length: 20 }, (_, i) => offer(`a.x/t${i}`, { rank: 90, group: 'G' }));
  const tree = buildTree('page', merge([offers]));
  assert.equal(tree.findIndex((n) => n.separator), QUICK_LIMIT);
});

test('an action missing its app becomes an install entry', () => {
  const tree = buildTree('image', merge([[offer('arcade.lens/read', { title: 'Read text', enabled: false, install: 'app:arcade.lens', appName: 'Arcade Lens' })]]));
  assert.equal(tree[0]!.title, 'Read text (install Arcade Lens)');
  assert.deepEqual(tree[0]!.action, { kind: 'install', app: 'arcade.lens', appName: 'Arcade Lens' });
});

test('answers to several queries merge, first query wins', () => {
  const merged = merge([[offer('a.x/one'), offer('a.x/two')], [offer('a.x/two'), offer('a.x/three')]]);
  assert.deepEqual(
    merged.map((a) => [a.offer.ref, a.query]),
    [
      ['a.x/one', 0],
      ['a.x/two', 0],
      ['a.x/three', 1],
    ],
  );
});

test('nothing offered means no menu', () => {
  assert.deepEqual(buildTree('audio', []), []);
});

test('the not-connected entry', () => {
  assert.equal(connectTree('missing').title, 'Arcade: install Arcade Tools to connect…');
  assert.deepEqual(connectTree('missing').action, { kind: 'connect' });
  assert.match(connectTree('denied').title, /refused/);
});
