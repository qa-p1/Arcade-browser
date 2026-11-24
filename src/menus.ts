// The right-click menus: one "Arcade" entry per kind of thing (an image, a link, a video, selected text, the
// page, a PDF), filled from the helper's offers. Chromium has no "menu is opening" event, so the menus are built
// ahead of time from each kind's types and rebuilt when the apps change.

import type { Item, Offer, Surface } from './protocol.ts';

/** The browser's own names for where a menu entry shows. */
export type MenuContextType = 'image' | 'link' | 'video' | 'audio' | 'selection' | 'page';

export type ContextKind = 'image' | 'link' | 'pdf-link' | 'video' | 'audio' | 'selection' | 'page' | 'pdf';

/** One `offers` question asked for a kind; a click on its answer builds the matching item. */
export interface Query {
  surface: Surface;
  item: Item;
}

export interface MenuContext {
  kind: ContextKind;
  /** The top entry's title; `%s` is the selected text (both browsers fill it in). */
  title: string;
  contexts: [MenuContextType, ...MenuContextType[]];
  targetUrlPatterns?: string[];
  documentUrlPatterns?: string[];
  queries: Query[];
}

const PDF_URLS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', 'file:///*.pdf'];

export const CONTEXTS: MenuContext[] = [
  { kind: 'image', title: 'Arcade: this image', contexts: ['image'], queries: [{ surface: 'browser-image', item: { type: 'file/image' } }] },
  { kind: 'link', title: 'Arcade: this link', contexts: ['link'], queries: [{ surface: 'browser-link', item: { type: 'text/url' } }] },
  {
    kind: 'pdf-link',
    title: 'Arcade: this PDF',
    contexts: ['link'],
    targetUrlPatterns: PDF_URLS,
    queries: [{ surface: 'browser-pdf', item: { type: 'file/pdf' } }],
  },
  {
    kind: 'video',
    title: 'Arcade: this video',
    contexts: ['video'],
    queries: [
      { surface: 'browser-video', item: { type: 'text/url', hints: ['video'] } },
      { surface: 'browser-video', item: { type: 'file/video' } },
    ],
  },
  {
    kind: 'audio',
    title: 'Arcade: this audio',
    contexts: ['audio'],
    queries: [
      { surface: 'browser-audio', item: { type: 'text/url', hints: ['audio'] } },
      { surface: 'browser-audio', item: { type: 'file/audio' } },
    ],
  },
  { kind: 'selection', title: 'Arcade: “%s”', contexts: ['selection'], queries: [{ surface: 'browser-selection', item: { type: 'text/plain' } }] },
  { kind: 'page', title: 'Arcade: this page', contexts: ['page'], queries: [{ surface: 'browser-page', item: { type: 'text/url', hints: ['page'] } }] },
  {
    kind: 'pdf',
    title: 'Arcade: this PDF',
    contexts: ['page'],
    documentUrlPatterns: PDF_URLS,
    queries: [{ surface: 'browser-pdf', item: { type: 'file/pdf' } }],
  },
];

/** What a click does. */
export type MenuAction =
  | { kind: 'run'; context: ContextKind; query: number; ref: string; title: string; appName: string; oneClick: boolean }
  | { kind: 'install'; app: string; appName: string }
  | { kind: 'more'; context: ContextKind }
  | { kind: 'connect' };

export interface MenuNode {
  title: string;
  enabled: boolean;
  action?: MenuAction;
  children?: MenuNode[];
  separator?: boolean;
}

/** An offer with the query it answered. */
export interface Answer {
  offer: Offer;
  query: number;
}

/** At most this many entries sit directly under the top entry before the groups. */
export const QUICK_LIMIT = 8;
/** A group this small or a menu this short is shown flat. */
const FLAT_LIMIT = 10;
const OTHER_APPS = 'Other apps';

function order(a: Offer, b: Offer): number {
  return (
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)) ||
    Number(b.enabled) - Number(a.enabled) ||
    b.rank - a.rank ||
    a.title.localeCompare(b.title)
  );
}

/** Each action once, from the first query that offered it (the queries are in the order the kind prefers). */
export function merge(answers: Offer[][]): Answer[] {
  const seen = new Set<string>();
  const out: Answer[] = [];
  answers.forEach((offers, query) => {
    for (const offer of offers) {
      if (seen.has(offer.ref)) continue;
      seen.add(offer.ref);
      out.push({ offer, query });
    }
  });
  return out;
}

function entry(context: ContextKind, { offer, query }: Answer): MenuNode {
  const app = offer.install?.startsWith('app:') ? offer.install.slice(4) : '';
  if (!offer.enabled && app) {
    return { title: `${offer.title} (install ${offer.appName})`, enabled: true, action: { kind: 'install', app, appName: offer.appName } };
  }
  if (!offer.enabled) {
    return { title: offer.reason ? `${offer.title} (${offer.reason})` : offer.title, enabled: false };
  }
  return {
    title: offer.title,
    enabled: true,
    action: { kind: 'run', context, query, ref: offer.ref, title: offer.title, appName: offer.appName, oneClick: Boolean(offer.oneClick) },
  };
}

/** Pinned, the user's defaults and the strongest matches first; the rest in their groups ("Images ▸ …"), other
 * apps' ways of doing the same job under "Other apps", and "More…" last. Empty when nothing is offered. */
export function buildTree(context: ContextKind, answers: Answer[]): MenuNode[] {
  if (answers.length === 0) return [];
  const sorted = [...answers].sort((a, b) => order(a.offer, b.offer));
  const quick = sorted.filter((a) => a.offer.enabled && !a.offer.other && (a.offer.pinned || a.offer.preferred || a.offer.rank >= 60)).slice(0, QUICK_LIMIT);
  const rest = sorted.filter((a) => !quick.includes(a));
  const nodes: MenuNode[] = quick.map((a) => entry(context, a));
  if (sorted.length <= FLAT_LIMIT) {
    nodes.push(...rest.map((a) => entry(context, a)));
  } else {
    const groups = new Map<string, Answer[]>();
    for (const a of rest) {
      const name = a.offer.other ? OTHER_APPS : a.offer.group || a.offer.appName;
      groups.set(name, [...(groups.get(name) ?? []), a]);
    }
    const names = [...groups.keys()].sort((a, b) => (a === OTHER_APPS ? 1 : b === OTHER_APPS ? -1 : a.localeCompare(b)));
    if (nodes.length > 0 && names.length > 0) nodes.push({ title: '', enabled: true, separator: true });
    for (const name of names) {
      const members = groups.get(name) ?? [];
      if (members.length === 1 && name !== OTHER_APPS) nodes.push(entry(context, members[0]!));
      else nodes.push({ title: name, enabled: true, children: members.map((a) => entry(context, a)) });
    }
  }
  nodes.push({ title: '', enabled: true, separator: true });
  nodes.push({ title: 'More…', enabled: true, action: { kind: 'more', context } });
  return nodes;
}

/** The one entry shown everywhere while the helper can't be reached. */
export function connectTree(state: string): MenuNode {
  const title = state === 'denied' ? 'Arcade: the helper refused this extension (open Arcade)' : 'Arcade: install Arcade Tools to connect…';
  return { title, enabled: true, action: { kind: 'connect' } };
}
