import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN, isMediaUrl, matchesPattern, parseConfig, settingsFrom, setupFor } from '../../src/sites.ts';

const on = { pageButtons: true, hoverButtons: true };

test('the built-in copy passes the same rules as a fetched catalog', () => {
  assert.deepEqual(parseConfig(BUILTIN), BUILTIN);
});

test('match patterns follow the browsers’ rules', () => {
  assert.ok(matchesPattern('https://www.youtube.com/*', 'https://www.youtube.com/watch?v=abc'));
  assert.ok(!matchesPattern('https://www.youtube.com/*', 'http://www.youtube.com/watch'));
  assert.ok(!matchesPattern('https://www.youtube.com/*', 'https://www.youtube.com.evil.example/watch'));
  assert.ok(matchesPattern('*://*.example.com/*', 'http://a.b.example.com/x'));
  assert.ok(matchesPattern('*://*.example.com/*', 'https://example.com/'));
  assert.ok(!matchesPattern('*://*.example.com/*', 'https://notexample.com/'));
  assert.ok(!matchesPattern('*://*/*', 'file:///home/me/a.html'));
  // No port in the pattern matches any port; a port in it must be that port.
  assert.ok(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:8123/watch'));
  assert.ok(matchesPattern('http://127.0.0.1:8123/*', 'http://127.0.0.1:8123/watch'));
  assert.ok(!matchesPattern('http://127.0.0.1:8124/*', 'http://127.0.0.1:8123/watch'));
  assert.ok(matchesPattern('https://vimeo.com/1*', 'https://vimeo.com/123'));
  assert.ok(!matchesPattern('https://vimeo.com/1*', 'https://vimeo.com/abc'));
  assert.ok(!matchesPattern('youtube.com', 'https://youtube.com/'));
});

test('a page gets its site’s buttons and the hover settings unless excluded or turned off', () => {
  const yt = setupFor(BUILTIN, 'https://www.youtube.com/watch?v=abc', on);
  assert.deepEqual(yt.buttons.map((b) => [b.id, b.action]), [['download', 'arcade.box/box:arcade.web.downloader']]);
  assert.equal(yt.hover?.video?.action, 'arcade.box/box:arcade.web.downloader');
  const other = setupFor(BUILTIN, 'https://example.com/', on);
  assert.deepEqual(other.buttons, []);
  assert.ok(other.hover);
  assert.equal(setupFor(BUILTIN, 'https://docs.google.com/document/d/1', on).hover, null);
  assert.deepEqual(setupFor(BUILTIN, 'https://www.youtube.com/watch?v=abc', { pageButtons: false, hoverButtons: true }).buttons, []);
  assert.equal(setupFor(BUILTIN, 'https://example.com/', { pageButtons: true, hoverButtons: false }).hover, null);
});

test('a fetched section keeps only what passes the catalog’s rules', () => {
  const good = { id: 'download', label: 'Download', action: 'arcade.box/box:arcade.web.downloader', anchors: ['#a'] };
  const config = parseConfig({
    sites: [
      { id: 'ok', name: 'OK', matches: ['https://ok.example/*', 'not a pattern'], buttons: [good, { ...good, anchors: ['<img src=x>'] }] },
      { id: 'markup', name: 'Markup', matches: ['https://m.example/*'], buttons: [{ ...good, anchors: ['a { color: red }'] }] },
      { id: 'regex', name: 'Regex', matches: ['https://r.example/*'], buttons: [{ ...good, path: '(' }] },
      { id: 'ok', name: 'Twice', matches: ['https://twice.example/*'], buttons: [good] },
      { id: 'Bad Id', name: 'Bad', matches: ['https://b.example/*'], buttons: [good] },
      { id: 'ref', name: 'Ref', matches: ['https://ref.example/*'], buttons: [{ ...good, action: 'javascript:alert(1)' }] },
      { id: 'input', name: 'Input', matches: ['https://i.example/*'], buttons: [{ ...good, input: 'selection' }] },
    ],
    hover: { minWidth: 5, minHeight: 'big', video: { label: 'x'.repeat(30), action: 'arcade.box/x' }, exclude: ['https://x.example/*', 3] },
  });
  assert.ok(config);
  assert.deepEqual(config.sites.map((s) => [s.id, s.matches, s.buttons.length]), [['ok', ['https://ok.example/*'], 1]]);
  assert.equal(config.sites[0]!.buttons[0]!.position, 'append');
  assert.deepEqual(config.hover, { minWidth: 100, minHeight: 100, exclude: ['https://x.example/*'] });
  assert.equal(parseConfig(undefined), null);
  assert.equal(parseConfig('browser'), null);
});

test('settings default to on and keep only true or false', () => {
  assert.deepEqual(settingsFrom(undefined), { pageButtons: true, hoverButtons: true, downloadNotices: true });
  assert.deepEqual(settingsFrom({ hoverButtons: false, downloadNotices: 'no' }), { pageButtons: true, hoverButtons: false, downloadNotices: true });
});

test('a page hands over only web, data or stream addresses', () => {
  assert.ok(isMediaUrl('https://example.com/a.png'));
  assert.ok(isMediaUrl('data:image/png;base64,AA=='));
  assert.ok(isMediaUrl('blob:https://www.youtube.com/123'));
  assert.ok(!isMediaUrl('file:///etc/passwd'));
  assert.ok(!isMediaUrl('javascript:alert(1)'));
  assert.ok(!isMediaUrl(42));
});
