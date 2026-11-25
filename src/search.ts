// The popup's search over every action of every installed app: the palette's offers for each kind of input, and
// a simple ranking by how well the words match.

import type { Item, Offer } from './protocol.ts';

/** The inputs the popup can give an action itself: none, typed text, this tab's address, or a file picked here. */
export const PALETTE_ITEMS: (Item | null)[] = [
  null,
  { type: 'text/plain' },
  { type: 'text/url' },
  { type: 'file/image' },
  { type: 'file/pdf' },
  { type: 'file/video' },
  { type: 'file/audio' },
  { type: 'file/any' },
];

export interface Entry {
  offer: Offer;
  /** What the action takes from the popup; null for an action that needs nothing. */
  item: Item | null;
}

/** Each action once, with the first kind of input that offered it. */
export function entries(answers: Offer[][]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  answers.forEach((offers, i) => {
    for (const offer of offers) {
      if (seen.has(offer.ref)) continue;
      seen.add(offer.ref);
      out.push({ offer, item: PALETTE_ITEMS[i] ?? null });
    }
  });
  return out;
}

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** How well `query` matches an entry; 0 for no match. Every word must match somewhere. */
export function score(entry: Entry, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const title = fold(entry.offer.title);
  const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean);
  const rest = fold(`${entry.offer.appName} ${entry.offer.group ?? ''} ${entry.offer.action}`);
  let total = 0;
  for (const word of words) {
    if (title.startsWith(word)) total += 30;
    else if (titleWords.some((w) => w.startsWith(word))) total += 20;
    else if (title.includes(word)) total += 10;
    else if (rest.includes(word)) total += 4;
    else return 0;
  }
  // Ties go to what the user keeps on top, then to stronger actions; an action that can't run now sinks below
  // the ones that can.
  const value = total + (entry.offer.pinned ? 3 : 0) + (entry.offer.preferred ? 2 : 0) + entry.offer.rank / 1000;
  return entry.offer.enabled ? value : value / 4;
}

export function search(all: Entry[], query: string, limit = 40): Entry[] {
  return all
    .map((e) => [e, score(e, query)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].offer.title.localeCompare(b[0].offer.title))
    .slice(0, limit)
    .map(([e]) => e);
}

/** What the popup asks for before running: nothing, text, an address, or a file of this kind. */
export function inputKind(item: Item | null): 'none' | 'text' | 'url' | 'file' {
  if (!item) return 'none';
  if (item.type === 'text/url') return 'url';
  if (item.type.startsWith('text/')) return 'text';
  return 'file';
}

/** The file picker's filter for a file type. */
export function accept(type: string): string {
  switch (type) {
    case 'file/image':
      return 'image/*';
    case 'file/pdf':
      return 'application/pdf,.pdf';
    case 'file/video':
      return 'video/*';
    case 'file/audio':
      return 'audio/*';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The address bar: "a" then a space, then words.

/** What a chosen suggestion carries, so Enter on it opens that action rather than a search. */
const PICKED = 'arcade-action:';

export interface OmniboxSuggestion {
  content: string;
  description: string;
}

/** Chromium reads descriptions as XML (with <match> and <dim>); Firefox shows them as plain text. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The best actions for what is typed, at most `limit`. */
export function omniboxSuggestions(all: Entry[], text: string, markup: boolean, limit = 6): OmniboxSuggestion[] {
  if (!text.trim()) return [];
  return search(all, text, limit).map((e) => {
    const title = `${e.offer.title} · ${e.offer.appName}`;
    return { content: `${PICKED}${e.offer.ref}`, description: markup ? `<match>${escapeXml(e.offer.title)}</match> <dim>· ${escapeXml(e.offer.appName)}</dim>` : title };
  });
}

/** The popup page (in a tab) that Enter opens: the chosen action, or a search for what was typed. */
export function omniboxPage(text: string, pageUrl: string | null): string {
  const params = new URLSearchParams({ tab: '1' });
  const trimmed = text.trim();
  if (trimmed.startsWith(PICKED)) params.set('ref', trimmed.slice(PICKED.length));
  else if (trimmed) params.set('q', trimmed);
  if (pageUrl && /^https?:/i.test(pageUrl)) params.set('page', pageUrl);
  return `popup.html?${params}`;
}
