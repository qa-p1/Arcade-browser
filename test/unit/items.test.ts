import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, fileName, fileType, ItemError, toBase64, urlFor, type Fetcher, type Target } from '../../src/items.ts';
import { MAX_DATA } from '../../src/protocol.ts';

function serve(body: Uint8Array | string, headers: Record<string, string> = {}, status = 200): { fetcher: Fetcher; calls: [string, RequestInit | undefined][] } {
  const calls: [string, RequestInit | undefined][] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push([url, init]);
    return new Response(status === 200 ? (body as BodyInit) : null, { status, headers });
  };
  return { fetcher, calls };
}

const none: Fetcher = async () => {
  throw new Error('no fetch expected');
};

test('links, pages and selections go as text', async () => {
  const link: Target = { context: 'link', linkUrl: 'https://example.com/a', pageUrl: 'https://example.com/' };
  assert.deepEqual(await buildItems({ type: 'text/url' }, link, none), [{ type: 'text/url', text: 'https://example.com/a', hints: undefined }]);
  const page: Target = { context: 'page', pageUrl: 'https://example.com/p' };
  assert.deepEqual(await buildItems({ type: 'text/url', hints: ['page'] }, page, none), [{ type: 'text/url', text: 'https://example.com/p', hints: ['page'] }]);
  const selection: Target = { context: 'selection', selectionText: '12 USD', pageUrl: 'https://example.com/' };
  assert.deepEqual(await buildItems({ type: 'text/plain' }, selection, none), [{ type: 'text/plain', text: '12 USD', hints: undefined }]);
  await assert.rejects(buildItems({ type: 'text/plain' }, { context: 'selection' }, none), ItemError);
});

test('a video in a stream is its page; a real file is its own address', () => {
  assert.equal(urlFor({ context: 'video', srcUrl: 'blob:https://www.youtube.com/123', pageUrl: 'https://www.youtube.com/watch?v=x' }), 'https://www.youtube.com/watch?v=x');
  assert.equal(urlFor({ context: 'video', srcUrl: 'https://cdn.example.com/clip.mp4', pageUrl: 'https://example.com/' }), 'https://cdn.example.com/clip.mp4');
  assert.equal(urlFor({ context: 'pdf', pageUrl: 'https://example.com/a.pdf', frameUrl: 'https://example.com/b.pdf' }), 'https://example.com/b.pdf');
});

test('pictures are fetched with the page’s cookies and handed over as bytes', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { fetcher, calls } = serve(png, { 'content-type': 'image/png' });
  const target: Target = { context: 'image', srcUrl: 'https://img.example.com/photos/cat%20one?size=2', pageUrl: 'https://example.com/' };
  const [item] = await buildItems({ type: 'file/image' }, target, fetcher);
  assert.deepEqual(item, { type: 'file/image', name: 'cat one.png', data: Buffer.from(png).toString('base64') });
  assert.equal(calls[0]![1]?.credentials, 'include');
});

test('an SVG is a file/svg and a linked PDF a file/pdf', async () => {
  const { fetcher } = serve('<svg/>', { 'content-type': 'image/svg+xml; charset=utf-8' });
  const [svg] = await buildItems({ type: 'file/image' }, { context: 'image', srcUrl: 'https://x.example/logo' }, fetcher);
  assert.equal(svg!.type, 'file/svg');
  assert.equal((svg as { name: string }).name, 'logo.svg');
  const pdf = serve('%PDF-1.7', { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Report 2026.pdf"' });
  const [item] = await buildItems({ type: 'file/pdf' }, { context: 'pdf-link', linkUrl: 'https://x.example/dl?id=3' }, pdf.fetcher);
  assert.deepEqual([item!.type, (item as { name: string }).name], ['file/pdf', 'Report 2026.pdf']);
});

test('streams, failures and oversized files are refused in plain words', async () => {
  await assert.rejects(buildItems({ type: 'file/video' }, { context: 'video', srcUrl: 'blob:https://x/1' }, none), /plays in pieces/);
  await assert.rejects(buildItems({ type: 'file/image' }, { context: 'image', srcUrl: 'https://x/a.png' }, serve('', {}, 404).fetcher), /answered 404/);
  const huge = serve('x', { 'content-length': String(MAX_DATA + 1), 'content-type': 'video/mp4' });
  await assert.rejects(buildItems({ type: 'file/video' }, { context: 'video', srcUrl: 'https://x/a.mp4' }, huge.fetcher), /larger than 48 MB/);
  await assert.rejects(buildItems({ type: 'file/image' }, { context: 'image', srcUrl: 'chrome://favicon/x' }, none), /can’t fetch chrome addresses/);
});

test('file names follow the content', () => {
  assert.equal(fileName('https://x/a/photo.php?id=1', 'image/jpeg', null), 'photo.jpg');
  assert.equal(fileName('https://x/a/photo.jpeg', 'image/jpeg', null), 'photo.jpeg');
  assert.equal(fileName('https://x/a/my.holiday', 'image/png', null), 'my.holiday.png');
  assert.equal(fileName('https://x/', 'image/webp', null, 'A page: title?'), 'A page  title.webp');
  assert.equal(fileName('data:image/png;base64,AAAA', 'image/png', null), 'download.png');
  assert.equal(fileName('https://x/f', 'application/octet-stream', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(fileName('https://x/a/notes.txt', 'text/plain', null), 'notes.txt');
});

test('types and base64', () => {
  assert.equal(fileType('file/image', 'image/png'), 'file/image');
  assert.equal(fileType('file/image', 'image/svg+xml'), 'file/svg');
  const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});
