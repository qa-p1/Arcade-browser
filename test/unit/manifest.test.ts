import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { manifest, storeVersion } from '../../src/manifest.ts';
import { CHROME_EXTENSION_ID, CHROME_EXTENSION_KEY, FIREFOX_ADDON_ID } from '../../src/protocol.ts';

test('the key gives the ID the helper answers', () => {
  // Chromium: the first 32 hex digits of SHA-256(DER public key), each mapped 0-f → a-p.
  const hash = createHash('sha256').update(Buffer.from(CHROME_EXTENSION_KEY, 'base64')).digest('hex');
  const id = [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, CHROME_EXTENSION_ID);
});

test('Chromium: a service worker and the key', () => {
  const m = manifest('chromium', '1.2.3');
  assert.equal(m.manifest_version, 3);
  assert.equal(m.key, CHROME_EXTENSION_KEY);
  assert.deepEqual(m.background, { service_worker: 'background.js' });
  assert.ok((m.permissions as string[]).includes('nativeMessaging'));
  assert.equal('browser_specific_settings' in m, false);
});

test('Firefox: a background script and the add-on ID', () => {
  const m = manifest('firefox', '1.2.3-rc.1') as Record<string, any>;
  assert.equal(m.version, '1.2.3');
  assert.equal('version_name' in m, false);
  assert.equal('key' in m, false);
  assert.deepEqual(m.background, { scripts: ['background.js'] });
  assert.equal(m.browser_specific_settings.gecko.id, FIREFOX_ADDON_ID);
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
});

test('versions', () => {
  assert.equal(storeVersion('1.0.0'), '1.0.0');
  assert.equal(storeVersion('1.0.0-rc.2'), '1.0.0');
  assert.equal(manifest('chromium', '1.0.0-rc.2').version_name, '1.0.0-rc.2');
  assert.throws(() => storeVersion('v1'));
});
