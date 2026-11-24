// The two manifests: Chromium (a service worker, and the fixed `key` that gives every unpacked copy the same ID)
// and Firefox (a background script, the add-on ID and Firefox's data-collection declaration).

import { CHROME_EXTENSION_KEY, FIREFOX_ADDON_ID } from './protocol.ts';

export type Target = 'chromium' | 'firefox';

/** The browser version each build needs: Chromium 120 for MV3 storage.session in pages and promise-based menus;
 * Firefox 140 (the current ESR) for `data_collection_permissions`. */
export const MINIMUM = { chromium: '120', firefox: '140.0' } as const;

/** A store version: one to four dot-separated numbers (a prerelease suffix is dropped). */
export function storeVersion(version: string): string {
  const core = version.split(/[-+]/)[0]!;
  if (!/^\d+(\.\d+){0,3}$/.test(core)) throw new Error(`${version} isn't a version a browser accepts`);
  return core;
}

export function manifest(target: Target, version: string): Record<string, unknown> {
  const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };
  const common = {
    manifest_version: 3,
    name: 'Arcade',
    version: storeVersion(version),
    ...(version !== storeVersion(version) ? { version_name: version } : {}),
    description: 'Your Arcade apps on images, links, videos, selected text and pages.',
    icons,
    action: { default_title: 'Arcade', default_popup: 'popup.html', default_icon: icons },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['contextMenus', 'nativeMessaging', 'notifications', 'storage', 'alarms', 'downloads'],
    host_permissions: ['<all_urls>'],
    // The buttons on pages (a Download button under a video, the button over pictures); top frames only.
    content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_idle' }],
  };
  if (target === 'chromium') {
    return {
      ...common,
      minimum_chrome_version: MINIMUM.chromium,
      key: CHROME_EXTENSION_KEY,
      background: { service_worker: 'background.js' },
    };
  }
  // Firefox has no version_name.
  const { version_name: _ignored, ...firefox } = common as typeof common & { version_name?: string };
  return {
    ...firefox,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: MINIMUM.firefox,
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}
