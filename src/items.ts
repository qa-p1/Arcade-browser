// Turning what was right-clicked into the items `run` takes. Pictures, PDFs and media are fetched by the extension
// (with the page's cookies) and handed over as bytes; links, pages and selections go as text.

import { MAX_DATA, type BrowserItem, type Item } from './protocol.ts';
import type { ContextKind } from './menus.ts';

/** What the browser told us about a click. */
export interface Target {
  context: ContextKind;
  pageUrl?: string;
  frameUrl?: string;
  linkUrl?: string;
  srcUrl?: string;
  selectionText?: string;
  /** The page's title, for names. */
  pageTitle?: string;
}

export class ItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemError';
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const FETCHABLE = /^(https?|data|file):/i;

/** The URL a kind's text item stands for. */
export function urlFor(target: Target): string | undefined {
  switch (target.context) {
    case 'link':
    case 'pdf-link':
      return target.linkUrl;
    case 'video':
    case 'audio':
      // A stream (`blob:`) is only meaningful inside the page; the page is what a downloader wants then.
      return target.srcUrl && /^https?:/i.test(target.srcUrl) ? target.srcUrl : target.pageUrl;
    case 'image':
      return target.srcUrl;
    default:
      return target.frameUrl && target.context === 'pdf' ? target.frameUrl : target.pageUrl;
  }
}

/** The URL whose bytes a kind's file item is. */
function sourceFor(target: Target): string | undefined {
  switch (target.context) {
    case 'image':
    case 'video':
    case 'audio':
      return target.srcUrl;
    case 'pdf-link':
    case 'link':
      return target.linkUrl;
    default:
      return target.frameUrl || target.pageUrl;
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
};

const KNOWN = new Set([...Object.values(EXTENSIONS), 'jpeg', 'tif', 'bin']);
const SCRIPTS = new Set(['php', 'asp', 'aspx', 'jsp', 'cgi', 'html', 'htm']);

/** A file name for bytes from `url`: the server's, the URL's last part, or the page's title, with an extension
 * that matches the content. The helper makes it safe again on its side. */
export function fileName(url: string, contentType: string, disposition: string | null, pageTitle?: string): string {
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const ext = EXTENSIONS[mime];
  let name = '';
  const star = disposition?.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/);
  try {
    if (star) name = decodeURIComponent(star[1]!.trim());
    else if (plain) name = plain[1]!.trim();
  } catch {
    name = '';
  }
  if (!name && /^https?:|^file:/i.test(url)) {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
      name = decodeURIComponent(last);
    } catch {
      name = '';
    }
  }
  name = name.replace(/[\u0000-\u001f]/g, '').trim();
  if (!name) name = (pageTitle ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'download';
  if (ext) {
    const found = name.match(/\.([a-z0-9]{1,5})$/i);
    const current = found?.[1]!.toLowerCase();
    const same = current === ext || (ext === 'jpg' && current === 'jpeg') || (ext === 'tiff' && current === 'tif');
    // A server script's name (`image.php`) or another media extension gives way to what the content is.
    const replace = found && current && (KNOWN.has(current) || SCRIPTS.has(current));
    if (!same) name = `${replace ? name.slice(0, -found[0].length) : name}.${ext}`;
  }
  return name;
}

/** The Link type of fetched bytes: the query's own, refined where the content says more (an SVG). */
export function fileType(queryType: string, contentType: string): string {
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'image/svg+xml') return 'file/svg';
  if (mime === 'application/pdf') return 'file/pdf';
  return queryType;
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

async function fetchFile(url: string, queryType: string, target: Target, fetcher: Fetcher): Promise<BrowserItem> {
  if (url.startsWith('blob:')) throw new ItemError('This plays in pieces inside the page, so it can’t be handed over. Try the page instead.');
  if (!FETCHABLE.test(url)) throw new ItemError(`Arcade can’t fetch ${url.split(':')[0]} addresses`);
  let response: Response;
  try {
    response = await fetcher(url, { credentials: 'include', cache: 'force-cache' });
  } catch (e) {
    throw new ItemError(`Couldn’t fetch it: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) throw new ItemError(`Couldn’t fetch it: the site answered ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_DATA) throw new ItemError(tooLarge());
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_DATA) throw new ItemError(tooLarge());
  const contentType = response.headers.get('content-type') ?? '';
  return {
    type: fileType(queryType, contentType),
    name: fileName(url, contentType, response.headers.get('content-disposition'), target.pageTitle),
    data: toBase64(bytes),
  };
}

function tooLarge(): string {
  return `It’s larger than ${MAX_DATA / 1024 / 1024} MB. Download it first, then use Arcade on the file.`;
}

/** The items for one run of an action that answered `item`. */
export async function buildItems(item: Item, target: Target, fetcher: Fetcher): Promise<BrowserItem[]> {
  if (item.type === 'text/plain' || (item.type.startsWith('text/') && item.type !== 'text/url')) {
    const text = target.selectionText ?? '';
    if (!text) throw new ItemError('Nothing is selected');
    return [{ type: item.type, text, hints: item.hints }];
  }
  if (item.type === 'text/url') {
    const url = urlFor(target);
    if (!url) throw new ItemError('There’s no address here');
    return [{ type: 'text/url', text: url, hints: item.hints }];
  }
  if (item.type.startsWith('file/')) {
    const url = sourceFor(target);
    if (!url) throw new ItemError('There’s nothing to fetch here');
    return [await fetchFile(url, item.type, target, fetcher)];
  }
  throw new ItemError(`Arcade can’t hand over ${item.type} from the browser`);
}
