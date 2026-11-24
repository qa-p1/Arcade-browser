// What the extension puts on web pages: the catalog's site buttons (a Download button under a YouTube video) and
// a small button over images and videos. Everything is drawn in a closed shadow root, so the page can't read which
// apps are installed or restyle the buttons, and only real clicks (`isTrusted`) count. The background decides what
// runs; this script only says which button was pressed, on what.

import { ext } from './api.ts';
import type { PageSetup, SiteButton } from './sites.ts';

/** What the background answers for a media button. */
interface MediaOffer {
  ref: string;
  title: string;
  appName: string;
}

const TAG = 'arcade-ext';

const STYLE = `
:host { all: initial; display: inline-block; vertical-align: middle; }
* { box-sizing: border-box; }
.wrap { font: 500 14px/1.2 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); position: relative;
  --fg: #0f0f0f; --bg: rgba(0,0,0,.05); --bg-hover: rgba(0,0,0,.1); --card: #fff; --line: rgba(0,0,0,.12); --accent: #16884b; --muted: #606060; }
.wrap.dark { --fg: #f1f1f1; --bg: rgba(255,255,255,.1); --bg-hover: rgba(255,255,255,.2); --card: #212121; --line: rgba(255,255,255,.16); --muted: #aaa; }
button { font: inherit; color: inherit; border: 0; cursor: pointer; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 10px; border-radius: 18px; background: var(--bg); white-space: nowrap; }
.pill:hover { background: var(--bg-hover); }
.pill:focus-visible, .item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pill svg { width: 20px; height: 20px; flex: none; }
.pill.busy { opacity: .6; cursor: progress; }
.site { margin: 0 8px; }
.float .pill { height: 30px; padding: 0 10px 0 8px; font-size: 13px; color: #fff; background: rgba(15,15,15,.78); box-shadow: 0 1px 4px rgba(0,0,0,.3); }
.float .pill:hover { background: rgba(15,15,15,.92); }
.float .pill svg { width: 16px; height: 16px; }
.menu { position: absolute; top: 36px; right: 0; min-width: 220px; max-width: 320px; padding: 6px 0; border-radius: 10px; background: var(--card);
  color: var(--fg); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.item { display: block; width: 100%; text-align: left; padding: 8px 14px; background: none; font-size: 13px; }
.item:hover, .item:focus { background: var(--bg); outline: none; }
.item small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
.note { padding: 8px 14px; font-size: 12px; color: var(--muted); max-width: 300px; }
.note.error { color: #c5221f; }
.wrap.dark .note.error { color: #f28b82; }
`;

type Shape = [tag: 'path' | 'rect', attrs: Record<string, string>];
const ICON_DOWNLOAD: Shape[] = [['path', { d: 'M12 4v11' }], ['path', { d: 'm7 10 5 5 5-5' }], ['path', { d: 'M5 20h14' }]];
const ICON_ARCADE: Shape[] = [
  ['rect', { x: '4', y: '4', width: '7', height: '7', rx: '2' }],
  ['rect', { x: '13', y: '4', width: '7', height: '7', rx: '2' }],
  ['rect', { x: '4', y: '13', width: '7', height: '7', rx: '2' }],
  ['path', { d: 'M16.5 13v7M13 16.5h7' }],
];

/** A line icon, built element by element (no markup from strings). */
function icon(shapes: Shape[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

let setup: PageSetup = { buttons: [], hover: null };

function send<T>(message: Record<string, unknown>): Promise<T> {
  return (ext.runtime.sendMessage(message) as Promise<T | { error: string }>).then((answer) => {
    if (answer && typeof answer === 'object' && 'error' in answer && typeof answer.error === 'string') throw new Error(answer.error);
    return answer as T;
  });
}

/** Whether the page looks dark where the buttons go, so they match it. */
function isDark(near: Element | null): boolean {
  for (let el: Element | null = near; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    const m = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
    return 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) < 128;
  }
  return document.documentElement.hasAttribute('dark') || matchMedia('(prefers-color-scheme: dark)').matches;
}

/** A host element with a closed shadow root holding `.wrap`. */
function makeHost(kind: string): { host: HTMLElement; wrap: HTMLDivElement } {
  const host = document.createElement(TAG);
  host.dataset.arcade = kind;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.append(style, wrap);
  // The page sees no clicks or keys from inside the buttons (a site's own shortcuts, or its click handlers).
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  return { host, wrap };
}

function pill(shapes: Shape[], label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pill';
  const span = document.createElement('span');
  span.textContent = label;
  b.append(icon(shapes), span);
  return b;
}

function short(text: string): string {
  return text.length > 40 ? 'Couldn’t start' : text;
}

/** Shows `text` on the button for a moment, then its label again. */
function flash(b: HTMLButtonElement, text: string, label: string): void {
  const span = b.querySelector('span')!;
  span.textContent = text;
  setTimeout(() => (span.textContent = label), 1800);
}

// ---------------------------------------------------------------------------------------------------------------
// Site buttons

const placed = new Map<string, HTMLElement>();
/** Each site button's `.wrap`, to match the page's light or dark look where it lands. */
const darkHosts = new WeakMap<HTMLElement, HTMLDivElement>();

function siteButton(b: SiteButton): HTMLElement {
  const { host, wrap } = makeHost(`site-${b.id}`);
  wrap.classList.add('site');
  const button = pill(ICON_DOWNLOAD, b.label);
  button.title = 'Arcade';
  button.addEventListener('click', (e) => {
    if (!e.isTrusted || button.classList.contains('busy')) return;
    button.classList.add('busy');
    send<{ needs?: string }>({ type: 'page-button', button: b.id })
      .then(
        (r) => flash(button, r.needs ? short(r.needs) : 'Opened', b.label),
        (err: Error) => flash(button, err.message.length > 40 ? 'Couldn’t start' : err.message, b.label),
      )
      .finally(() => button.classList.remove('busy'));
  });
  wrap.append(button);
  darkHosts.set(host, wrap);
  return host;
}

function pathMatches(b: SiteButton): boolean {
  if (!b.path) return true;
  try {
    return new RegExp(b.path).test(location.pathname);
  } catch {
    return false;
  }
}

function placeButtons(): void {
  for (const b of setup.buttons) {
    let host = placed.get(b.id);
    if (!pathMatches(b)) {
      host?.remove();
      continue;
    }
    if (host?.isConnected) continue;
    let anchor: Element | null = null;
    for (const selector of b.anchors) {
      try {
        anchor = document.querySelector(selector);
      } catch {
        anchor = null;
      }
      if (anchor) break;
    }
    if (!anchor) continue;
    host ??= siteButton(b);
    placed.set(b.id, host);
    if (b.position === 'prepend') anchor.prepend(host);
    else if (b.position === 'before') anchor.before(host);
    else if (b.position === 'after') anchor.after(host);
    else anchor.append(host);
    darkHosts.get(host)?.classList.toggle('dark', isDark(anchor));
  }
}

let observer: MutationObserver | null = null;
let scheduled = 0;

function watchPage(): void {
  observer?.disconnect();
  observer = null;
  if (setup.buttons.length === 0) {
    for (const host of placed.values()) host.remove();
    placed.clear();
    return;
  }
  const later = () => {
    if (scheduled) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      placeButtons();
    }, 250);
  };
  observer = new MutationObserver(later);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  placeButtons();
}

// ---------------------------------------------------------------------------------------------------------------
// The button over images and videos

type Media = HTMLImageElement | HTMLVideoElement;

let floating: { host: HTMLElement; wrap: HTMLDivElement; button: HTMLButtonElement; menu: HTMLDivElement | null } | null = null;
let current: Media | null = null;
let hideTimer = 0;

function mediaAt(x: number, y: number): Media | null {
  // Players put layers over the video, so look under the pointer rather than at the event's target.
  for (const el of document.elementsFromPoint(x, y).slice(0, 8)) {
    if (el.tagName === TAG.toUpperCase()) return null;
    if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement) return el;
  }
  return null;
}

function srcOf(media: Media): string {
  if (media instanceof HTMLImageElement) return media.currentSrc || media.src;
  return media.currentSrc || media.src || media.querySelector('source')?.src || '';
}

function bigEnough(media: Media): boolean {
  const hover = setup.hover;
  if (!hover) return false;
  const r = media.getBoundingClientRect();
  return r.width >= hover.minWidth && r.height >= hover.minHeight && getComputedStyle(media).visibility !== 'hidden';
}

function ensureFloating(): NonNullable<typeof floating> {
  if (floating?.host.isConnected) return floating;
  const { host, wrap } = makeHost('hover');
  wrap.classList.add('float');
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;display:none;';
  const button = pill(ICON_ARCADE, 'Arcade');
  button.addEventListener('click', (e) => {
    if (!e.isTrusted || !current) return;
    void pressed(current);
  });
  wrap.append(button);
  (document.body ?? document.documentElement).append(host);
  floating = { host, wrap, button, menu: null };
  return floating;
}

function position(): void {
  if (!floating || !current) return;
  const r = current.getBoundingClientRect();
  const w = floating.host.offsetWidth || 90;
  floating.host.style.left = `${Math.max(4, Math.min(r.right, innerWidth) - w - 8)}px`;
  floating.host.style.top = `${Math.max(4, r.top + 8)}px`;
}

function show(media: Media): void {
  const f = ensureFloating();
  clearTimeout(hideTimer);
  if (current !== media) {
    closeMenu();
    current = media;
    const video = media instanceof HTMLVideoElement && setup.hover?.video;
    const span = document.createElement('span');
    span.textContent = video ? setup.hover!.video!.label : 'Arcade';
    f.button.replaceChildren(icon(video ? ICON_DOWNLOAD : ICON_ARCADE), span);
    f.wrap.classList.toggle('dark', false);
  }
  f.host.style.display = 'block';
  position();
}

function hide(): void {
  if (!floating) return;
  floating.host.style.display = 'none';
  closeMenu();
  current = null;
}

function closeMenu(): void {
  floating?.menu?.remove();
  if (floating) floating.menu = null;
}

function inside(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function onMove(e: PointerEvent): void {
  if (!setup.hover) return;
  const overFloat = floating && floating.host.style.display !== 'none' && inside(floating.host.getBoundingClientRect(), e.clientX, e.clientY);
  if (overFloat || floating?.menu) {
    clearTimeout(hideTimer);
    return;
  }
  const media = mediaAt(e.clientX, e.clientY);
  if (media && bigEnough(media) && srcOf(media) && (media instanceof HTMLImageElement || setup.hover.video)) {
    show(media);
    return;
  }
  if (current) {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 300);
  }
}

function note(menu: HTMLDivElement, text: string, error = false): void {
  const p = document.createElement('div');
  p.className = error ? 'note error' : 'note';
  p.textContent = text;
  menu.replaceChildren(p);
}

async function pressed(media: Media): Promise<void> {
  const f = ensureFloating();
  const src = srcOf(media);
  if (media instanceof HTMLVideoElement) {
    const label = setup.hover?.video?.label ?? 'Download';
    try {
      const r = await send<{ needs?: string }>({ type: 'page-media-run', kind: 'video', src });
      flash(f.button, r.needs ? short(r.needs) : 'Opened', label);
    } catch (err) {
      flash(f.button, 'Couldn’t start', label);
      console.warn('Arcade:', (err as Error).message);
    }
    return;
  }
  if (f.menu) {
    closeMenu();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  f.menu = menu;
  f.wrap.append(menu);
  f.wrap.classList.toggle('dark', isDark(document.body));
  note(menu, 'Loading…');
  let offers: MediaOffer[];
  try {
    ({ offers } = await send<{ offers: MediaOffer[] }>({ type: 'page-media-offers', kind: 'image', src }));
  } catch (err) {
    note(menu, (err as Error).message, true);
    return;
  }
  if (f.menu !== menu) return;
  if (offers.length === 0) {
    note(menu, 'No Arcade app works on images yet.');
    return;
  }
  menu.replaceChildren(
    ...offers.map((offer) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item';
      item.setAttribute('role', 'menuitem');
      item.textContent = offer.title;
      const small = document.createElement('small');
      small.textContent = offer.appName;
      item.append(small);
      item.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        note(menu, 'Starting…');
        send<{ needs?: string; form?: true }>({ type: 'page-media-run', kind: 'image', src, ref: offer.ref }).then(
          (r) => {
            if (r.needs) {
              note(menu, r.needs, true);
              return;
            }
            note(menu, r.form ? `${offer.title}: choose its options in the new window` : `${offer.title}: started`);
            setTimeout(() => f.menu === menu && closeMenu(), 1200);
          },
          (err: Error) => note(menu, err.message, true),
        );
      });
      return item;
    }),
  );
  // Arrow keys move through the list, Escape closes it.
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.item')];
    const at = items.indexOf((menu.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Escape') closeMenu();
    else return;
    e.preventDefault();
  });
  menu.querySelector<HTMLButtonElement>('.item')?.focus();
}

let hoverOn = false;

function watchHover(): void {
  if (setup.hover && !hoverOn) {
    hoverOn = true;
    document.addEventListener('pointermove', onMove, { passive: true, capture: true });
    addEventListener('scroll', position, { passive: true, capture: true });
    addEventListener('resize', position, { passive: true });
    document.addEventListener('pointerdown', (e) => {
      if (floating?.menu && e.target !== floating.host) closeMenu();
    }, true);
  } else if (!setup.hover && hoverOn) {
    hoverOn = false;
    document.removeEventListener('pointermove', onMove, { capture: true });
    removeEventListener('scroll', position, { capture: true });
    removeEventListener('resize', position);
    hide();
  }
}

// ---------------------------------------------------------------------------------------------------------------

async function load(): Promise<void> {
  try {
    setup = await send<PageSetup>({ type: 'page-setup' });
  } catch {
    setup = { buttons: [], hover: null };
  }
  watchPage();
  watchHover();
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('settings' in changes || 'browserConfig' in changes)) void load();
});

void load();
