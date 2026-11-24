// The extension's background: the helper connection, the right-click menus, runs, job tracking, notifications.

import { ext, TARGET, type PageMessage } from './api.ts';
import { HelperClient, HelperError, type PortLike } from './helper.ts';
import { buildItems, ItemError, type Target } from './items.ts';
import { finishedMessage, JobWatcher } from './jobs.ts';
import { buildTree, connectTree, CONTEXTS, merge, shortlist, type Answer, type ContextKind, type MenuAction, type MenuNode } from './menus.ts';
import { fileTypeForName } from './kinds.ts';
import {
  BUILTIN,
  CATALOG_MAX_AGE_MS,
  CATALOG_URL,
  isMediaUrl,
  parseConfig,
  settingsFrom,
  setupFor,
  type BrowserConfig,
  type PageSettings,
  type PageSetup,
} from './sites.ts';
import { HOST_NAME, MAX_DATA, TOOLS_RELEASES, type BrowserItem, type FormAnswer, type Hello, type Job, type Offer, type Prefs } from './protocol.ts';
import { entries, PALETTE_ITEMS, type Entry } from './search.ts';
import { rememberable, type Values } from './form.ts';

const client = new HelperClient(
  () => ext.runtime.connectNative(HOST_NAME) as unknown as PortLike,
  () => ext.runtime.lastError?.message,
);

const watcher = new JobWatcher((method, params, timeoutMs) => client.request(method, params, timeoutMs), {
  onUpdate: (jobs) => {
    void badge();
    broadcast({ type: 'jobs', jobs });
  },
  onFinished: (job) => void notifyFinished(job),
  onTracked: (ids) => void ext.storage.session.set({ tracked: ids }),
});
client.keepOpen = () => watcher.busy;

let hello: Hello | null = null;

// ---------------------------------------------------------------------------------------------------------------
// Menus

/** A pending run whose form is open. */
interface Pending {
  action: Extract<MenuAction, { kind: 'run' }>;
  target: Target;
}

function create(props: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve) => {
    ext.contextMenus.create(props, () => {
      // A duplicate id after a racing rebuild is harmless; anything else is worth a log line.
      const error = ext.runtime.lastError;
      if (error) console.warn('Arcade menu:', error.message);
      resolve();
    });
  });
}

async function addNodes(nodes: MenuNode[], parentId: string, table: Record<string, MenuAction>, next: () => string): Promise<void> {
  for (const node of nodes) {
    const id = next();
    if (node.separator) {
      await create({ id, parentId, type: 'separator', contexts: ['all'] });
      continue;
    }
    await create({ id, parentId, title: node.title, enabled: node.enabled, contexts: ['all'] });
    if (node.action) table[id] = node.action;
    if (node.children) await addNodes(node.children, id, table, next);
  }
}

async function offersFor(kind: ContextKind): Promise<Offer[][]> {
  const context = CONTEXTS.find((c) => c.kind === kind)!;
  return Promise.all(
    context.queries.map((q) => client.request<{ offers: Offer[] }>('offers', { surface: q.surface, items: [q.item] }).then((r) => r.offers)),
  );
}

async function rebuildNow(): Promise<void> {
  pageOffers.clear();
  const trees: [(typeof CONTEXTS)[number], MenuNode[]][] = [];
  try {
    hello = await client.request<Hello>('hello');
    for (const context of CONTEXTS) trees.push([context, buildTree(context.kind, merge(await offersFor(context.kind)))]);
  } catch (e) {
    console.warn('Arcade helper:', e instanceof Error ? e.message : e);
    trees.length = 0;
  }
  await ext.contextMenus.removeAll();
  const table: Record<string, MenuAction> = {};
  let n = 0;
  const next = () => `m${++n}`;
  if (trees.length === 0) {
    const node = connectTree(client.state);
    const id = next();
    await create({ id, title: node.title, contexts: ['page', 'link', 'image', 'selection', 'video', 'audio'] });
    table[id] = node.action!;
  }
  for (const [context, nodes] of trees) {
    if (nodes.length === 0) continue;
    const id = `top-${context.kind}`;
    await create({
      id,
      title: context.title,
      contexts: context.contexts,
      ...(context.targetUrlPatterns ? { targetUrlPatterns: context.targetUrlPatterns } : {}),
      ...(context.documentUrlPatterns ? { documentUrlPatterns: context.documentUrlPatterns } : {}),
    });
    await addNodes(nodes, id, table, next);
  }
  await ext.storage.session.set({ menus: table });
  broadcast({ type: 'state', state: client.state, detail: client.detail });
}

let rebuilding: Promise<void> = Promise.resolve();
/** Rebuilds one at a time; the last request wins. */
function rebuildMenus(): Promise<void> {
  rebuilding = rebuilding.then(rebuildNow, rebuildNow);
  return rebuilding;
}

// ---------------------------------------------------------------------------------------------------------------
// Running

function targetOf(context: ContextKind, info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Target {
  return {
    context,
    pageUrl: info.pageUrl ?? tab?.url,
    frameUrl: info.frameUrl,
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    selectionText: info.selectionText,
    pageTitle: tab?.title,
  };
}

async function start(action: Pending['action'], target: Target, values: Values): Promise<number> {
  const context = CONTEXTS.find((c) => c.kind === action.context)!;
  const query = context.queries[action.query] ?? context.queries[0]!;
  const items = await buildItems(query.item, target, (url, init) => fetch(url, init));
  // Large pictures take a moment to hand over.
  const { job } = await client.request<{ job: number }>('run', { ref: action.ref, items, values }, 120_000);
  void watcher.track(job);
  void badge();
  return job;
}

function words(e: unknown): string {
  if (e instanceof HelperError && e.message === 'nothing to run on') {
    return 'Your Arcade helper can’t run actions that need no input yet. Update Arcade Tools.';
  }
  if (e instanceof HelperError && (e.code === 'missing' || (e.code === 'denied' && e.message.includes('only the Arcade extension')))) {
    return 'Arcade isn’t connected. Open the Arcade button for help.';
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

async function notify(id: string, title: string, message: string): Promise<void> {
  await ext.notifications.create(id, { type: 'basic', iconUrl: ext.runtime.getURL('icons/128.png'), title, message });
}

async function openForm(action: Pending['action'], target: Target): Promise<void> {
  const token = crypto.randomUUID();
  await ext.storage.session.set({ [`pending:${token}`]: { action, target } satisfies Pending });
  await ext.windows.create({ url: ext.runtime.getURL(`form.html#${token}`), type: 'popup', width: 460, height: 640 });
}

async function openPage(path: string): Promise<void> {
  await ext.tabs.create({ url: ext.runtime.getURL(path) });
}

async function install(app: string, appName: string): Promise<void> {
  try {
    const answer = await client.request<{ via: string; url?: string }>('install', { app });
    if (answer.via === 'page' && answer.url) await ext.tabs.create({ url: answer.url });
    else await notify(`install-${app}`, `Installing ${appName}`, 'Arcade Tools is installing it. The menus update when it’s ready.');
  } catch (e) {
    await notify(`install-${app}`, `Couldn’t install ${appName}`, words(e));
  }
}

/** A menu click. Also reachable from tests (`globalThis.arcade`), since automation can't open a browser menu. */
async function handleClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const { menus } = (await ext.storage.session.get('menus')) as { menus?: Record<string, MenuAction> };
  const action = menus?.[String(info.menuItemId)];
  if (!action) return;
  switch (action.kind) {
    case 'connect':
      await openPage('popup.html?tab=1');
      return;
    case 'install':
      await install(action.app, action.appName);
      return;
    case 'more':
      await openPage('popup.html?tab=1');
      return;
    case 'run': {
      const target = targetOf(action.context, info, tab);
      if (!action.oneClick) {
        await openForm(action, target);
        return;
      }
      try {
        await start(action, target, {});
      } catch (e) {
        await notify(`error-${Date.now()}`, `Couldn’t start ${action.title}`, words(e));
      }
    }
  }
}

ext.contextMenus.onClicked.addListener((info, tab) => void handleClick(info, tab));

// ---------------------------------------------------------------------------------------------------------------
// Jobs

async function badge(): Promise<void> {
  const running = watcher.running.length;
  await ext.action.setBadgeText({ text: running ? String(running) : '' });
  await ext.action.setBadgeBackgroundColor({ color: '#16884b' });
}

async function notifyFinished(job: Job): Promise<void> {
  if (job.status === 'cancelled') return;
  const title = job.status === 'failed' ? `${job.title} didn’t finish` : job.title;
  await notify(`job-${job.id}`, title, finishedMessage(job));
}

ext.notifications.onClicked.addListener((id) => {
  if (id.startsWith('job-')) void openPage(`popup.html?tab=1#job=${id.slice(4)}`);
  if (id.startsWith('download-')) void openDownload(id.slice('download-'.length));
  void ext.notifications.clear(id);
});

// ---------------------------------------------------------------------------------------------------------------
// Pages

function broadcast(message: unknown): void {
  // No page open is the usual case.
  ext.runtime.sendMessage(message).catch(() => {});
}

async function answer(message: PageMessage): Promise<unknown> {
  switch (message.type) {
    case 'status': {
      try {
        hello = await client.request<Hello>('hello');
        await watcher.refresh();
      } catch {
        // The state says why.
      }
      let hostAccess = true;
      if (TARGET === 'firefox') hostAccess = await ext.permissions.contains({ origins: ['<all_urls>'] });
      return { state: client.state, detail: client.detail, hello, jobs: watcher.jobs, tools: TOOLS_RELEASES, hostAccess, target: TARGET };
    }
    case 'pending': {
      const key = `pending:${message.token}`;
      const pending = (await ext.storage.session.get(key))[key] as Pending | undefined;
      if (!pending) return { error: 'This form has expired. Right-click again.' };
      const form = await client.request<FormAnswer>('form', { ref: pending.action.ref });
      const rememberedKey = `values:${pending.action.ref}`;
      const remembered = ((await ext.storage.local.get(rememberedKey))[rememberedKey] ?? {}) as Values;
      return { pending, form, remembered };
    }
    case 'run': {
      const key = `pending:${message.token}`;
      const pending = (await ext.storage.session.get(key))[key] as Pending | undefined;
      if (!pending) return { error: 'This form has expired. Right-click again.' };
      const form = await client.request<FormAnswer>('form', { ref: pending.action.ref });
      const job = await start(pending.action, pending.target, message.values);
      await ext.storage.session.remove(key);
      await ext.storage.local.set({ [`values:${pending.action.ref}`]: rememberable(form.options, message.values) });
      return { job };
    }
    case 'cancel':
      await client.request('cancel', { job: message.job });
      return {};
    case 'dismiss':
      await client.request('dismiss', message.job === undefined ? {} : { job: message.job });
      await watcher.refresh();
      broadcast({ type: 'jobs', jobs: watcher.jobs });
      return {};
    case 'install': {
      const app = hello?.apps.find((a) => a.id === message.app);
      await install(message.app, app?.name ?? message.app);
      return {};
    }
    case 'refresh-menus':
      await rebuildMenus();
      return { state: client.state };
    case 'catalog':
      return { entries: await catalog() };
    case 'form':
      return client.request<FormAnswer>('form', { ref: message.ref });
    case 'run-items': {
      const items = checkedItems(message.items);
      const form = await client.request<FormAnswer>('form', { ref: message.ref });
      const { job } = await client.request<{ job: number }>('run', { ref: message.ref, items, values: message.values }, 120_000);
      void watcher.track(job);
      void badge();
      await ext.storage.local.set({ [`values:${message.ref}`]: rememberable(form.options, message.values) });
      return { job };
    }
    case 'prefs':
      return client.request<Prefs>('prefs.get');
    case 'settings':
      return settings();
    case 'settings-set': {
      const next = settingsFrom(message.settings);
      await ext.storage.local.set({ settings: next });
      return next;
    }
    case 'download': {
      const key = `download:${message.token}`;
      const pending = (await ext.storage.session.get(key))[key] as Downloaded | undefined;
      if (!pending) return { error: 'This download’s list has expired. Use the right-click menu on the file instead.' };
      return { name: pending.name, offers: pending.offers };
    }
    case 'download-run': {
      const job = await runDownload(message.token, message.ref, message.values);
      const form = await client.request<FormAnswer>('form', { ref: message.ref });
      await ext.storage.local.set({ [`values:${message.ref}`]: rememberable(form.options, message.values) });
      return { job };
    }
    case 'prefs-set': {
      const prefs = await client.request<Prefs>('prefs.set', { prefs: message.prefs });
      cachedCatalog = null;
      void rebuildMenus();
      return prefs;
    }
  }
}

/** Items the popup built: text or bytes only (never a path on disk), within the size the helper takes. */
function checkedItems(items: unknown): BrowserItem[] {
  if (!Array.isArray(items)) throw new Error('No input');
  return items.map((item) => {
    const i = item as Record<string, unknown>;
    if (typeof i.type !== 'string') throw new Error('An input has no type');
    if (typeof i.text === 'string') return { type: i.type, text: i.text };
    if (typeof i.data === 'string' && typeof i.name === 'string') {
      if (i.data.length > (MAX_DATA / 3) * 4 + 4) throw new Error(`It’s larger than ${MAX_DATA / 1024 / 1024} MB`);
      return { type: i.type, name: i.name, data: i.data };
    }
    throw new Error('An input has no text or file');
  });
}

let cachedCatalog: { at: number; entries: Entry[] } | null = null;

/** Every action of every installed app, with the kind of input the popup gives it. */
async function catalog(): Promise<Entry[]> {
  if (cachedCatalog && Date.now() - cachedCatalog.at < 30_000) return cachedCatalog.entries;
  const answers = await Promise.all(
    PALETTE_ITEMS.map((item) => client.request<{ offers: Offer[] }>('offers', { surface: 'palette', items: item ? [item] : [] }).then((r) => r.offers)),
  );
  cachedCatalog = { at: Date.now(), entries: entries(answers) };
  return cachedCatalog.entries;
}

const PAGE_MESSAGES = new Set(['page-setup', 'page-button', 'page-media-offers', 'page-media-run']);

ext.runtime.onMessage.addListener((message: PageMessage | ContentMessage, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id || !message || typeof message !== 'object' || !('type' in message)) return false;
  // The extension's own pages may ask anything; the script on web pages only says which of its buttons was pressed.
  const own = typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL(''));
  let work: Promise<unknown>;
  if (own) work = answer(message as PageMessage);
  else if (sender.tab && sender.frameId === 0 && PAGE_MESSAGES.has(message.type)) work = fromPage(message as ContentMessage, sender);
  else return false;
  work.then(
    (result) => sendResponse(result),
    (e: unknown) => sendResponse({ error: e instanceof ItemError ? e.message : words(e) }),
  );
  return true;
});

// ---------------------------------------------------------------------------------------------------------------
// Buttons on pages (content.ts)

/** What the script on a web page sends. */
type ContentMessage =
  | { type: 'page-setup' }
  | { type: 'page-button'; button: string }
  | { type: 'page-media-offers'; kind: 'image'; src: string }
  | { type: 'page-media-run'; kind: 'image' | 'video'; src: string; ref?: string };

async function settings(): Promise<PageSettings> {
  return settingsFrom((await ext.storage.local.get('settings')).settings);
}

interface StoredConfig {
  at: number;
  /** The catalog's section; null when the catalog had none (this release's copy is used then). */
  config: unknown;
}

/** The catalog's `browser` section: the fetched copy while it's fresh enough to use, else this release's own. */
async function browserConfig(): Promise<BrowserConfig> {
  const stored = (await ext.storage.local.get('browserConfig')).browserConfig as StoredConfig | undefined;
  if (!stored || Date.now() - stored.at > CATALOG_MAX_AGE_MS) void refreshConfig(stored?.at);
  return (stored?.config ? parseConfig(stored.config) : null) ?? BUILTIN;
}

let fetchingConfig = false;
async function refreshConfig(seen: number | undefined): Promise<void> {
  if (fetchingConfig) return;
  fetchingConfig = true;
  try {
    const response = await fetch(CATALOG_URL, { cache: 'no-cache', credentials: 'omit' });
    if (!response.ok) throw new Error(`the catalog answered ${response.status}`);
    const catalog = (await response.json()) as { browser?: unknown };
    const config = parseConfig(catalog?.browser);
    // Something newer (a test's own copy) wins over this fetch.
    const now = (await ext.storage.local.get('browserConfig')).browserConfig as StoredConfig | undefined;
    if (now?.at !== seen) return;
    await ext.storage.local.set({ browserConfig: { at: Date.now(), config } satisfies StoredConfig });
  } catch (e) {
    console.warn('Arcade catalog:', e instanceof Error ? e.message : e);
  } finally {
    fetchingConfig = false;
  }
}

const pageOffers = new Map<ContextKind, { at: number; answers: Promise<Answer[]> }>();

/** A kind's offers for buttons on pages, kept for a minute (every page load asks). Nothing while not connected. */
function answersFor(kind: ContextKind): Promise<Answer[]> {
  const cached = pageOffers.get(kind);
  if (cached && Date.now() - cached.at < 60_000) return cached.answers;
  const answers = offersFor(kind).then(merge, () => [] as Answer[]);
  pageOffers.set(kind, { at: Date.now(), answers });
  return answers;
}

async function findOffer(ref: string, kinds: ContextKind[]): Promise<{ kind: ContextKind; answer: Answer } | null> {
  for (const kind of kinds) {
    const answer = (await answersFor(kind)).find((a) => a.offer.ref === ref);
    if (answer) return { kind, answer };
  }
  return null;
}

/** Where a page button's action may be offered: the page itself first, then as a link to it. */
const PAGE_KINDS: ContextKind[] = ['page', 'link'];
/** Where a video button's action may be offered: the video, else the page or a link to the video. */
const VIDEO_KINDS: ContextKind[] = ['video', 'page', 'link'];

/** Runs `ref` on `target` as a right-click on the first kind that offers it would: its form, or at once. */
type PageResult = { job?: number; form?: true; install?: true; needs?: string };
/** What the last button on a page did (the tests can't look inside the button). */
let lastPageResult: PageResult | null = null;

async function runOffered(ref: string, kinds: ContextKind[], target: Omit<Target, 'context'>): Promise<PageResult> {
  lastPageResult = await runOfferedNow(ref, kinds, target);
  return lastPageResult;
}

async function runOfferedNow(ref: string, kinds: ContextKind[], target: Omit<Target, 'context'>): Promise<PageResult> {
  const found = await findOffer(ref, kinds);
  if (!found) throw new Error('That needs an Arcade app that isn’t installed');
  const { offer, query } = found.answer;
  if (!offer.enabled) {
    const app = offer.install?.startsWith('app:') ? offer.install.slice(4) : '';
    if (app) {
      await install(app, offer.appName);
      return { install: true };
    }
    // An engine (yt-dlp, FFmpeg) is the app's to install.
    const reason = offer.reason ?? `${offer.title} can’t run here`;
    const how = offer.install?.startsWith('engine:') ? ` Install it in ${offer.appName}, then try again.` : '';
    await notify(`error-${Date.now()}`, `${offer.title} isn’t ready`, `${reason}.${how}`);
    return { needs: reason };
  }
  const action: Pending['action'] = { kind: 'run', context: found.kind, query, ref, title: offer.title, appName: offer.appName, oneClick: Boolean(offer.oneClick) };
  const full: Target = { ...target, context: found.kind };
  if (!action.oneClick) {
    await openForm(action, full);
    return { form: true };
  }
  return { job: await start(action, full, {}) };
}

async function pageSetup(url: string): Promise<PageSetup> {
  const setup = setupFor(await browserConfig(), url, await settings());
  const offered = async (ref: string, kinds: ContextKind[]) => (await findOffer(ref, kinds)) !== null;
  const buttons = [];
  for (const b of setup.buttons) if (await offered(b.action, PAGE_KINDS)) buttons.push(b);
  let hover = setup.hover;
  if (hover?.video && !(await offered(hover.video.action, VIDEO_KINDS))) {
    const { video: _, ...rest } = hover;
    hover = rest;
  }
  return { buttons, hover };
}

async function fromPage(message: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Where the page is comes from the browser, not from the page.
  const pageUrl = sender.url ?? sender.tab?.url;
  if (!pageUrl || !/^(https?|file):/i.test(pageUrl)) throw new Error('Not on this page');
  const base = { pageUrl, pageTitle: sender.tab?.title };
  switch (message.type) {
    case 'page-setup':
      return pageSetup(pageUrl);
    case 'page-button': {
      const setup = setupFor(await browserConfig(), pageUrl, await settings());
      const button = setup.buttons.find((b) => b.id === message.button);
      if (!button) throw new Error('This button is gone; reload the page');
      return runOffered(button.action, PAGE_KINDS, { ...base, linkUrl: pageUrl });
    }
    case 'page-media-offers': {
      if (!isMediaUrl(message.src)) throw new Error('Arcade can’t take this picture');
      return { offers: shortlist(await answersFor('image')).map(({ offer }) => ({ ref: offer.ref, title: offer.title, appName: offer.appName })) };
    }
    case 'page-media-run': {
      if (!isMediaUrl(message.src)) throw new Error('Arcade can’t take this');
      if (message.kind === 'image') {
        if (typeof message.ref !== 'string') throw new Error('Which action?');
        return runOffered(message.ref, ['image'], { ...base, srcUrl: message.src });
      }
      const setup = setupFor(await browserConfig(), pageUrl, await settings());
      const video = setup.hover?.video;
      if (!video) throw new Error('This button is gone; reload the page');
      const direct = /^https?:/i.test(message.src) ? message.src : undefined;
      return runOffered(video.action, VIDEO_KINDS, { ...base, srcUrl: message.src, linkUrl: direct ?? pageUrl });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Finished downloads

interface Downloaded {
  path: string;
  type: string;
  name: string;
  offers: { ref: string; title: string; appName: string; oneClick: boolean }[];
}

const NOTICE_ACTIONS = 3;

/** A finished download: a notification naming what Arcade can do with it. */
async function downloaded(id: number): Promise<string | null> {
  if (!(await settings()).downloadNotices) return null;
  const [item] = await ext.downloads.search({ id });
  if (!item?.filename || item.state !== 'complete' || item.exists === false) return null;
  const type = fileTypeForName(item.filename);
  let answers: Answer[];
  try {
    const { offers } = await client.request<{ offers: Offer[] }>('offers', { surface: 'browser-download', items: [{ type, size: item.fileSize > 0 ? item.fileSize : undefined }] });
    answers = merge([offers]);
  } catch {
    return null;
  }
  const offers = shortlist(answers).map(({ offer }) => ({ ref: offer.ref, title: offer.title, appName: offer.appName, oneClick: Boolean(offer.oneClick) }));
  if (offers.length === 0) return null;
  const name = item.filename.split(/[\\/]/).pop() ?? item.filename;
  const token = crypto.randomUUID();
  await ext.storage.session.set({ [`download:${token}`]: { path: item.filename, type, name, offers } satisfies Downloaded });
  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: ext.runtime.getURL('icons/128.png'),
    title: `Downloaded ${name}`,
    message: offers.slice(0, NOTICE_ACTIONS).map((o) => o.title).join(' · '),
  };
  // Firefox has no notification buttons; there the notification opens the list.
  if (TARGET === 'chromium') options.buttons = offers.slice(0, 2).map((o) => ({ title: o.title }));
  await ext.notifications.create(`download-${token}`, options);
  return token;
}

async function openDownload(token: string): Promise<void> {
  await ext.windows.create({ url: ext.runtime.getURL(`download.html#${token}`), type: 'popup', width: 460, height: 600 });
}

/** Runs one of a download's offers on the file, with these options. */
async function runDownload(token: string, ref: string, values: Values): Promise<number> {
  const key = `download:${token}`;
  const pending = (await ext.storage.session.get(key))[key] as Downloaded | undefined;
  const offer = pending?.offers.find((o) => o.ref === ref);
  if (!pending || !offer) throw new Error('This download’s list has expired. Use the right-click menu on the file instead.');
  const items: BrowserItem[] = [{ type: pending.type, path: pending.path }];
  const { job } = await client.request<{ job: number }>('run', { ref, items, values });
  void watcher.track(job);
  void badge();
  return job;
}

ext.downloads?.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') void downloaded(delta.id);
});

ext.notifications.onButtonClicked?.addListener((id, index) => {
  if (!id.startsWith('download-')) return;
  const token = id.slice('download-'.length);
  void (async () => {
    const pending = ((await ext.storage.session.get(`download:${token}`))[`download:${token}`] ?? null) as Downloaded | null;
    const offer = pending?.offers[index];
    if (!offer) return;
    if (!offer.oneClick) {
      await openDownload(token);
      return;
    }
    try {
      await runDownload(token, offer.ref, {});
    } catch (e) {
      await notify(`error-${Date.now()}`, `Couldn’t start ${offer.title}`, words(e));
    }
  })();
  void ext.notifications.clear(id);
});

// ---------------------------------------------------------------------------------------------------------------
// Start-up

ext.runtime.onInstalled.addListener((details) => {
  void rebuildMenus();
  // First install: the status page says whether Arcade is connected and what to do if not.
  if (details.reason === 'install') void openPage('popup.html?tab=1');
});
ext.runtime.onStartup.addListener(() => void rebuildMenus());
ext.alarms.create('refresh', { periodInMinutes: 15 });
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh') {
    void rebuildMenus();
    void browserConfig();
  }
});
client.onState((state) => broadcast({ type: 'state', state, detail: client.detail }));

void (async () => {
  const { tracked } = (await ext.storage.session.get('tracked')) as { tracked?: number[] };
  if (tracked?.length) void watcher.track(...tracked);
})();

// What the end-to-end tests drive: the same handlers the browser calls, and what they show.
(globalThis as { arcade?: unknown }).arcade = {
  handleClick,
  rebuildMenus,
  jobs: () => watcher.jobs,
  state: () => ({ state: client.state, detail: client.detail }),
  /** Puts this section in place of the catalog's, as if just fetched (tests serve their own pages). */
  setConfig: (config: unknown) => ext.storage.local.set({ browserConfig: { at: Date.now() + CATALOG_MAX_AGE_MS, config } satisfies StoredConfig }),
  pageSetup,
  lastPageResult: () => lastPageResult,
  resetPageResult: () => {
    lastPageResult = null;
  },
  imageOffers: async () => shortlist(await answersFor('image')).map(({ offer }) => ({ ref: offer.ref, oneClick: Boolean(offer.oneClick) })),
  downloaded,
};
