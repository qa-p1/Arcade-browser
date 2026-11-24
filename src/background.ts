// The extension's background: the helper connection, the right-click menus, runs, job tracking, notifications.

import { ext, TARGET, type PageMessage } from './api.ts';
import { HelperClient, HelperError, type PortLike } from './helper.ts';
import { buildItems, ItemError, type Target } from './items.ts';
import { finishedMessage, JobWatcher } from './jobs.ts';
import { buildTree, connectTree, CONTEXTS, merge, type ContextKind, type MenuAction, type MenuNode } from './menus.ts';
import { HOST_NAME, TOOLS_RELEASES, type FormAnswer, type Hello, type Job, type Offer } from './protocol.ts';
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
  if (e instanceof HelperError && (e.code === 'missing' || e.code === 'denied')) return 'Arcade isn’t connected. Open the Arcade button for help.';
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
  }
}

ext.runtime.onMessage.addListener((message: PageMessage, sender, sendResponse) => {
  // Only this extension's own pages talk to the background.
  if (sender.id !== ext.runtime.id || !message || typeof message !== 'object' || !('type' in message)) return false;
  answer(message).then(
    (result) => sendResponse(result),
    (e: unknown) => sendResponse({ error: e instanceof ItemError ? e.message : words(e) }),
  );
  return true;
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
  if (alarm.name === 'refresh') void rebuildMenus();
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
};
