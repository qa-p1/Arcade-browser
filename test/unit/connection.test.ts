import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionWords } from '../../src/connection.ts';

const base = { detail: '', hello: null, tools: 'https://example.com/tools' };

test('connected names the installed apps and the helper', () => {
  const words = connectionWords({
    ...base,
    state: 'connected',
    hello: { helper: '1.1.2', browser: 'chromium', apps: [{ installed: true }, { installed: false }, { installed: true }] as any },
  });
  assert.deepEqual(words, { ok: true, title: 'Connected · 2 Arcade apps · helper 1.1.2', fix: '' });
});

test('each problem says what fixes it', () => {
  for (const state of ['missing', 'unknown', 'disconnected', 'denied'] as const) {
    const words = connectionWords({ ...base, state });
    assert.equal(words.ok, false, state);
    assert.ok(words.fix.length > 20, state);
  }
  assert.match(connectionWords({ ...base, state: 'missing' }).fix, /Install Arcade Tools/);
  assert.match(connectionWords({ ...base, state: 'disconnected' }).fix, /Open Arcade Tools/);
});
