// Where the extension puts buttons on pages: the `browser` section of the Arcade catalog (qa-p1/Arcade-catalog).
// Sites, CSS anchors and actions are data, so a site that changes its layout is fixed by a catalog edit. The
// catalog's validator checks the same rules; anything that fails them here is dropped, never trusted.

export const CATALOG_URL = 'https://raw.githubusercontent.com/qa-p1/Arcade-catalog/main/catalog.json';
/** How old the fetched copy may get before it's fetched again. */
export const CATALOG_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface SiteButton {
  id: string;
  label: string;
  action: string;
  anchors: string[];
  position: 'append' | 'prepend' | 'before' | 'after';
  /** A regular expression the page's path must match; absent means every page of the site. */
  path?: string;
}

export interface Site {
  id: string;
  name: string;
  matches: string[];
  buttons: SiteButton[];
}

export interface Hover {
  minWidth: number;
  minHeight: number;
  video?: { label: string; action: string };
  exclude: string[];
}

export interface BrowserConfig {
  sites: Site[];
  hover: Hover;
}

/** The catalog's section as this release knows it: used until the catalog is fetched, and if it can't be. */
export const BUILTIN: BrowserConfig = {
  sites: [
    {
      id: 'youtube',
      name: 'YouTube',
      matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://music.youtube.com/*'],
      buttons: [
        {
          id: 'download',
          label: 'Download',
          action: 'arcade.box/box:arcade.web.downloader',
          anchors: [
            'ytd-watch-metadata #top-level-buttons-computed',
            'ytd-watch-metadata #actions-inner #menu',
            'ytd-watch-metadata #actions',
            'ytm-slim-video-action-bar-renderer .slim-video-action-bar-actions',
            'ytmusic-player-bar .middle-controls-buttons',
          ],
          position: 'append',
          path: '^/(watch|shorts/)',
        },
      ],
    },
    {
      id: 'vimeo',
      name: 'Vimeo',
      matches: ['https://vimeo.com/*'],
      buttons: [
        {
          id: 'download',
          label: 'Download',
          action: 'arcade.box/box:arcade.web.downloader',
          anchors: ['[data-testid="vod-actions"]', '.vp-video-actions', 'main h1'],
          position: 'append',
          path: '^/[0-9]+',
        },
      ],
    },
  ],
  hover: {
    minWidth: 120,
    minHeight: 80,
    video: { label: 'Download', action: 'arcade.box/box:arcade.web.downloader' },
    exclude: ['https://docs.google.com/*', 'https://mail.google.com/*', 'https://www.figma.com/*', 'https://www.canva.com/*'],
  },
};

const MATCH = /^(https?|\*):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(:[0-9]+)?(\/.*)$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const REF = /^[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._:-]+$/;
const POSITIONS = new Set(['append', 'prepend', 'before', 'after']);

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

export function isSelector(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[<>{};]/.test(value);
}

export function isPattern(value: unknown): value is string {
  return typeof value === 'string' && MATCH.test(value);
}

function isPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 200) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function pixels(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 16 && value <= 2000 ? value : fallback;
}

function button(raw: unknown): SiteButton | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (!(typeof b.id === 'string' && ID.test(b.id)) || !text(b.label, 24) || !(typeof b.action === 'string' && REF.test(b.action))) return null;
  if ((b.input ?? 'page') !== 'page') return null;
  const anchors = Array.isArray(b.anchors) ? b.anchors.filter(isSelector) : [];
  if (anchors.length === 0) return null;
  const position = b.position ?? 'append';
  if (typeof position !== 'string' || !POSITIONS.has(position)) return null;
  if (b.path !== undefined && !isPath(b.path)) return null;
  return { id: b.id, label: b.label, action: b.action, anchors, position: position as SiteButton['position'], ...(b.path ? { path: b.path as string } : {}) };
}

/** The `browser` section of a fetched catalog, keeping what passes the catalog's rules; null when there's none. */
export function parseConfig(raw: unknown): BrowserConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sites: Site[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(r.sites) ? r.sites : []) {
    if (!s || typeof s !== 'object') continue;
    const site = s as Record<string, unknown>;
    if (typeof site.id !== 'string' || !ID.test(site.id) || seen.has(site.id) || !text(site.name, 40)) continue;
    const matches = Array.isArray(site.matches) ? site.matches.filter(isPattern) : [];
    const buttons = (Array.isArray(site.buttons) ? site.buttons : []).map(button).filter((b): b is SiteButton => b !== null);
    if (matches.length === 0 || buttons.length === 0) continue;
    seen.add(site.id);
    sites.push({ id: site.id, name: site.name as string, matches, buttons });
  }
  const h = (r.hover && typeof r.hover === 'object' ? r.hover : {}) as Record<string, unknown>;
  const v = (h.video && typeof h.video === 'object' ? h.video : null) as Record<string, unknown> | null;
  const video = v && text(v.label, 24) && typeof v.action === 'string' && REF.test(v.action) ? { label: v.label, action: v.action } : undefined;
  return {
    sites,
    hover: {
      minWidth: pixels(h.minWidth, 100),
      minHeight: pixels(h.minHeight, 100),
      ...(video ? { video } : {}),
      exclude: Array.isArray(h.exclude) ? h.exclude.filter(isPattern) : [],
    },
  };
}

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `url` is matched by a browser match pattern (`https://*.example.com/*`). A pattern with no port matches
 * any port, as the browsers' own patterns do. */
export function matchesPattern(pattern: string, url: string): boolean {
  const m = MATCH.exec(pattern);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const [, scheme, host, port, path] = m as unknown as [string, string, string, string | undefined, string];
  const protocol = u.protocol.slice(0, -1);
  if (scheme === '*' ? protocol !== 'http' && protocol !== 'https' : protocol !== scheme) return false;
  const hostname = u.hostname.toLowerCase();
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2).toLowerCase();
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
    } else if (hostname !== host.toLowerCase()) return false;
  }
  if (port && u.port !== port.slice(1)) return false;
  const re = new RegExp(`^${path.split('*').map(escape).join('.*')}$`);
  return re.test(u.pathname + u.search);
}

/** What a page at `url` gets: the buttons of the first site that matches it, and the hover settings unless the
 * page is excluded. */
export function setupFor(config: BrowserConfig, url: string, prefs: { pageButtons: boolean; hoverButtons: boolean }): PageSetup {
  const site = prefs.pageButtons ? config.sites.find((s) => s.matches.some((p) => matchesPattern(p, url))) : undefined;
  const hover = prefs.hoverButtons && !config.hover.exclude.some((p) => matchesPattern(p, url)) ? config.hover : null;
  return { buttons: site?.buttons ?? [], hover };
}

export interface PageSetup {
  buttons: SiteButton[];
  hover: Hover | null;
}

/** The extension's own settings for pages (Settings page). */
export interface PageSettings {
  pageButtons: boolean;
  hoverButtons: boolean;
  downloadNotices: boolean;
}

export const DEFAULT_SETTINGS: PageSettings = { pageButtons: true, hoverButtons: true, downloadNotices: true };

export function settingsFrom(raw: unknown): PageSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof PageSettings) => (typeof r[key] === 'boolean' ? (r[key] as boolean) : DEFAULT_SETTINGS[key]);
  return { pageButtons: pick('pageButtons'), hoverButtons: pick('hoverButtons'), downloadNotices: pick('downloadNotices') };
}

/** A web address a page may hand over for an image or video: http(s), data or a page stream (`blob:`). */
export function isMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8 * 1024 * 1024 && /^(https?:|data:|blob:)/i.test(value);
}
