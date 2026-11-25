import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accept, entries, inputKind, PALETTE_ITEMS, score, search } from '../../src/search.ts';
import type { Offer } from '../../src/protocol.ts';

const box = JSON.parse(readFileSync(new URL('../fixtures/box.json', import.meta.url), 'utf8')) as Record<string, Offer[]>;

function offer(ref: string, title: string, extra: Partial<Offer> = {}): Offer {
  const [app, action] = ref.split('/') as [string, string];
  return { app, action, title, rank: 30, enabled: true, appName: 'Arcade Box', ref, ...extra };
}

test('the palette asks for no input first, then text, an address and files', () => {
  assert.equal(PALETTE_ITEMS[0], null);
  assert.deepEqual(
    PALETTE_ITEMS.slice(1).map((i) => i!.type),
    ['text/plain', 'text/url', 'file/image', 'file/pdf', 'file/video', 'file/audio', 'file/any'],
  );
});

test('each action once, with the first input that offered it', () => {
  const all = entries([[], box.selection!, box.link!, box.image!]);
  const refs = all.map((e) => e.offer.ref);
  assert.equal(new Set(refs).size, refs.length);
  const hash = all.find((e) => e.offer.ref === 'arcade.box/box:arcade.developer.hash')!;
  assert.equal(hash.item?.type, 'text/plain', 'hashing typed text before a file');
  const snapshot = all.find((e) => e.offer.ref === 'arcade.box/box:arcade.web.snapshot')!;
  assert.equal(snapshot.item?.type, 'text/url');
});

test('search ranks title starts over words over anywhere', () => {
  const all = entries([
    [
      offer('a.x/1', 'Unit Converter'),
      offer('a.x/2', 'Currency Converter'),
      offer('a.x/3', 'Convert to WebP', { group: 'Images' }),
      offer('a.x/4', 'Hash / Checksum', { group: 'Developer' }),
    ],
  ]);
  assert.deepEqual(
    search(all, 'conv').map((e) => e.offer.title),
    ['Convert to WebP', 'Currency Converter', 'Unit Converter'],
  );
  assert.deepEqual(search(all, 'developer').map((e) => e.offer.title), ['Hash / Checksum'], 'group names match too');
  assert.deepEqual(search(all, 'unit conv').map((e) => e.offer.title), ['Unit Converter'], 'every word must match');
  assert.equal(search(all, 'zzz').length, 0);
  assert.equal(search(all, '').length, 4);
});

test('actions that can’t run now sink; pinned ones win ties; accents are ignored', () => {
  const ranked = entries([[offer('a.x/1', 'Convert to PNG', { enabled: false, reason: 'libvips isn’t installed' }), offer('a.x/2', 'Currency Converter')]]);
  assert.deepEqual(search(ranked, 'conv').map((e) => e.offer.ref), ['a.x/2', 'a.x/1']);
  const all = entries([[offer('a.x/1', 'Résumé builder', { enabled: false }), offer('a.x/2', 'Resume tool', { pinned: true })]]);
  assert.deepEqual(search(all, 'resume').map((e) => e.offer.ref), ['a.x/2', 'a.x/1']);
  assert.ok(score(all[0]!, 'resu') > 0);
});

test('inputs the popup asks for', () => {
  assert.equal(inputKind(null), 'none');
  assert.equal(inputKind({ type: 'text/url' }), 'url');
  assert.equal(inputKind({ type: 'text/plain' }), 'text');
  assert.equal(inputKind({ type: 'file/pdf' }), 'file');
  assert.equal(accept('file/image'), 'image/*');
  assert.equal(accept('file/any'), '');
});

test('the address bar suggests the best actions and opens the chosen one', async () => {
  const { omniboxPage, omniboxSuggestions } = await import('../../src/search.ts');
  const all = [
    { offer: offer('arcade.box/web.downloader', 'Download video & audio'), item: { type: 'text/url' } },
    { offer: offer('arcade.box/text.case', 'Change case'), item: { type: 'text/plain' } },
  ];
  const chromium = omniboxSuggestions(all, 'down', true);
  assert.equal(chromium.length, 1);
  assert.equal(chromium[0]!.content, 'arcade-action:arcade.box/web.downloader');
  // Chromium reads the description as XML.
  assert.equal(chromium[0]!.description, '<match>Download video &amp; audio</match> <dim>· Arcade Box</dim>');
  assert.equal(omniboxSuggestions(all, 'down', false)[0]!.description, 'Download video & audio · Arcade Box');
  assert.deepEqual(omniboxSuggestions(all, '   ', true), []);
  assert.equal(omniboxPage('arcade-action:arcade.box/web.downloader', 'https://www.youtube.com/watch?v=x'), 'popup.html?tab=1&ref=arcade.box%2Fweb.downloader&page=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx');
  assert.equal(omniboxPage(' compress pdf ', 'chrome://newtab'), 'popup.html?tab=1&q=compress+pdf');
  assert.equal(omniboxPage('', null), 'popup.html?tab=1');
});
