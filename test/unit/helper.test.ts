import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDisconnect, HelperClient, HelperError, type PortLike } from '../../src/helper.ts';

/** A port that answers like the helper: `reply(request)` returns the answer, or undefined to stay silent. */
class FakePort implements PortLike {
  sent: { id: number; method: string; params: unknown }[] = [];
  messageListeners: ((m: unknown) => void)[] = [];
  disconnectListeners: ((p: PortLike) => void)[] = [];
  disconnected = false;
  error: { message?: string } | null = null;
  reply: (r: { id: number; method: string; params: unknown }) => unknown;
  constructor(reply: FakePort['reply']) {
    this.reply = reply;
  }
  onMessage = { addListener: (l: (m: unknown) => void) => this.messageListeners.push(l) };
  onDisconnect = { addListener: (l: (p: PortLike) => void) => this.disconnectListeners.push(l) };
  postMessage(message: unknown): void {
    const r = message as { id: number; method: string; params: unknown };
    this.sent.push(r);
    const answer = this.reply(r);
    if (answer !== undefined) queueMicrotask(() => this.messageListeners.forEach((l) => l(answer)));
  }
  disconnect(): void {
    this.disconnected = true;
  }
  close(message: string): void {
    this.error = { message };
    this.disconnectListeners.forEach((l) => l(this));
  }
}

test('requests are matched to answers by id', async () => {
  const port = new FakePort((r) => ({ id: r.id, result: { method: r.method } }));
  const client = new HelperClient(() => port, () => undefined, { idleMs: 10 });
  const [a, b] = await Promise.all([client.request('hello'), client.request('offers', { surface: 'browser-link' })]);
  assert.deepEqual(a, { method: 'hello' });
  assert.deepEqual(b, { method: 'offers' });
  assert.deepEqual(port.sent.map((r) => r.params), [{}, { surface: 'browser-link' }]);
  assert.equal(client.state, 'connected');
  client.close();
});

test('an error answer rejects with the helper’s code', async () => {
  const port = new FakePort((r) => ({ id: r.id, error: { code: 'unsupported', message: 'unknown method nope' } }));
  const client = new HelperClient(() => port, () => undefined);
  await assert.rejects(client.request('nope'), (e: HelperError) => e.code === 'unsupported' && e.message === 'unknown method nope');
  client.close();
});

test('a missing host reads as missing, and the next request connects again', async () => {
  const ports: FakePort[] = [];
  const client = new HelperClient(
    () => {
      const port = new FakePort(() => undefined);
      ports.push(port);
      return port;
    },
    () => undefined,
  );
  const first = client.request('hello');
  ports[0]!.close('Specified native messaging host not found.');
  await assert.rejects(first, (e: HelperError) => e.code === 'missing');
  assert.equal(client.state, 'missing');
  const second = client.request('hello');
  assert.equal(ports.length, 2, 'a new port for the next request');
  ports[1]!.messageListeners.forEach((l) => l({ id: 2, result: { helper: '1.1.1' } }));
  assert.deepEqual(await second, { helper: '1.1.1' });
  assert.equal(client.state, 'connected');
  client.close();
});

test('Chromium’s lastError is used when the port has no error', async () => {
  const port = new FakePort(() => undefined);
  const client = new HelperClient(() => port, () => 'Access to the specified native messaging host is forbidden.');
  const pending = client.request('hello');
  port.disconnectListeners.forEach((l) => l(port));
  await assert.rejects(pending, (e: HelperError) => e.code === 'denied');
});

test('the helper’s refusal of another extension closes the port as denied', async () => {
  const port = new FakePort(() => ({ error: { code: 'denied', message: 'only the Arcade extension may use the helper' } }));
  const client = new HelperClient(() => port, () => undefined);
  await assert.rejects(client.request('hello'), (e: HelperError) => e.code === 'denied');
  assert.equal(client.state, 'denied');
  assert.ok(port.disconnected);
});

test('a silent helper times out', async () => {
  const port = new FakePort(() => undefined);
  const client = new HelperClient(() => port, () => undefined, { timeoutMs: 20 });
  await assert.rejects(client.request('jobs'), (e: HelperError) => e.code === 'timeout');
  client.close();
});

test('the port closes when idle, unless something keeps it open', async () => {
  const port = new FakePort((r) => ({ id: r.id, result: {} }));
  const client = new HelperClient(() => port, () => undefined, { idleMs: 15 });
  let keep = true;
  client.keepOpen = () => keep;
  await client.request('hello');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(port.disconnected, false);
  keep = false;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(port.disconnected, true);
});

test('state changes are reported once each', async () => {
  const port = new FakePort((r) => ({ id: r.id, result: {} }));
  const client = new HelperClient(() => port, () => undefined);
  const seen: string[] = [];
  client.onState((s) => seen.push(s));
  await client.request('hello');
  await client.request('hello');
  port.close('Native host has exited.');
  assert.deepEqual(seen, ['connected', 'disconnected']);
});

test('disconnect messages from both browsers', () => {
  assert.equal(classifyDisconnect('Specified native messaging host not found.'), 'missing');
  assert.equal(classifyDisconnect('No such native application dev.arcade.helper'), 'missing');
  assert.equal(classifyDisconnect('Access to the specified native messaging host is forbidden.'), 'denied');
  assert.equal(classifyDisconnect('Native host has exited.'), 'disconnected');
  assert.equal(classifyDisconnect('Error when communicating with the native messaging host.'), 'disconnected');
});
