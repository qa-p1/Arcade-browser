// The toolbar popup, the Island in the browser: search every action of every installed app and run it here (on
// typed text, this page's address or a file picked here), the actions for this page, and the recent jobs.

import { ask, ext } from '../api.ts';
import type { Values } from '../form.ts';
import type { ConnectionState } from '../helper.ts';
import { fileType, toBase64 } from '../items.ts';
import { finishedMessage } from '../jobs.ts';
import { isFinished, MAX_DATA, type BrowserItem, type FormAnswer, type Hello, type Job, type Prefs } from '../protocol.ts';
import { accept, inputKind, search, type Entry } from '../search.ts';
import { fill, h } from './dom.ts';
import { formView } from './form-view.ts';

interface Status {
  state: ConnectionState;
  detail: string;
  hello: Hello | null;
  jobs: Job[];
  tools: string;
  hostAccess: boolean;
  target: string;
}

const root = document.getElementById('root')!;
const params = new URLSearchParams(location.search);
const focusJob = Number(new URLSearchParams(location.hash.slice(1)).get('job') ?? 0);
if (params.has('tab')) root.classList.replace('popup', 'wide');

let status: Status | null = null;
let catalog: Entry[] = [];
let prefs: Prefs | null = null;
let page: { url: string; title: string } | null = null;
let query = '';
const jobsEl = h('div', { class: 'list', id: 'jobs' });
const resultsEl = h('div', { id: 'results' });
const body = h('div', { class: 'fields', id: 'body' });

// ---------------------------------------------------------------------------------------------------------------
// Connection

function stateLine(s: Status): HTMLElement {
  if (s.state === 'connected') {
    const apps = (s.hello?.apps ?? []).filter((a) => a.installed).length;
    return h('div', { class: 'state ok', id: 'state' }, h('span', { class: 'dot' }), `Connected · ${apps} app${apps === 1 ? '' : 's'}`);
  }
  const words = s.state === 'denied' ? 'The Arcade helper refused this extension' : 'Not connected';
  return h('div', { class: 'state bad', id: 'state' }, h('span', { class: 'dot' }), words);
}

function notices(s: Status): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (s.state === 'missing' || s.state === 'disconnected' || s.state === 'unknown') {
    out.push(
      h(
        'div',
        { class: 'card', id: 'connect' },
        h('div', { class: 't-heading' }, 'Install Arcade Tools to connect'),
        h('p', { class: 'muted t-small' }, 'Arcade Tools sets up the Arcade helper, which this extension talks to. Install it, open it once, then try again.'),
        h(
          'div',
          { class: 'btn-group' },
          h('a', { class: 'btn primary', href: s.tools, target: '_blank', rel: 'noreferrer' }, 'Get Arcade Tools'),
          h('button', { class: 'btn', id: 'retry', onclick: () => void retry() }, 'Try again'),
        ),
        s.detail ? h('p', { class: 'muted t-caption' }, s.detail) : null,
      ),
    );
  }
  if (s.state === 'denied') {
    out.push(h('div', { class: 'card' }, h('p', { class: 'muted t-small' }, 'Only the official Arcade extension can use the helper. Install it from Arcade Tools’ Everywhere page.')));
  }
  if (!s.hostAccess) {
    out.push(
      h(
        'div',
        { class: 'card', id: 'access' },
        h('div', { class: 't-heading' }, 'Let Arcade fetch pictures and files'),
        h('p', { class: 'muted t-small' }, 'To hand a picture or PDF from a page to your apps, Arcade needs to read it from the site.'),
        h('button', { class: 'btn primary', onclick: () => void ext.permissions.request({ origins: ['<all_urls>'] }).then(() => void retry()) }, 'Allow'),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

function jobRow(job: Job): HTMLElement {
  const running = !isFinished(job);
  const texts = job.status === 'done' ? (job.texts ?? []) : [];
  const files = job.status === 'done' ? (job.files ?? []) : [];
  const line = running ? job.message || (job.status === 'queued' ? 'Waiting' : job.status === 'ask' ? 'Choose where to save it' : 'Working') : finishedMessage(job);
  return h(
    'div',
    { class: `row${job.id === focusJob ? ' focus' : ''}`, 'data-job': job.id, 'data-status': job.status },
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, job.title, job.status === 'failed' ? h('span', { class: 'badge' }, 'Failed') : null),
      h('div', { class: 'row-sub' }, `${job.app} · ${line}`),
      running && job.fraction !== undefined ? h('div', { class: 'job-progress' }, h('div', { style: `width:${Math.round(job.fraction * 100)}%` })) : null,
      texts.map((text) => h('div', { class: 'job-text mono' }, text)),
      files.length > 1 ? h('div', { class: 'row-sub mono' }, files.join('\n')) : null,
    ),
    h(
      'div',
      { class: 'row-end' },
      texts.length ? h('button', { class: 'btn sm', onclick: () => void navigator.clipboard.writeText(texts[0]!) }, 'Copy') : null,
      running
        ? h('button', { class: 'btn sm ghost', onclick: () => void ask({ type: 'cancel', job: job.id }) }, 'Cancel')
        : h('button', { class: 'btn sm ghost', title: 'Remove from the list', onclick: () => void ask({ type: 'dismiss', job: job.id }) }, 'Clear'),
    ),
  );
}

function renderJobs(jobs: Job[]): void {
  const recent = jobs.slice(0, 20);
  if (recent.length === 0) fill(jobsEl, h('div', { class: 'empty' }, 'Right-click a picture, a link, selected text or the page, or search above.'));
  else fill(jobsEl, recent.map(jobRow));
}

// ---------------------------------------------------------------------------------------------------------------
// Actions

function isPinned(ref: string): boolean {
  return prefs?.pinned.includes(ref) ?? false;
}

async function togglePin(ref: string): Promise<void> {
  if (!prefs) prefs = await ask<Prefs>({ type: 'prefs' });
  const pinned = isPinned(ref) ? prefs.pinned.filter((r) => r !== ref) : [...prefs.pinned, ref];
  prefs = await ask<Prefs>({ type: 'prefs-set', prefs: { ...prefs, pinned } });
  renderResults();
}

function needs(entry: Entry): string {
  switch (inputKind(entry.item)) {
    case 'url':
      return 'this page';
    case 'text':
      return 'text';
    case 'file':
      return 'a file';
    default:
      return '';
  }
}

function actionRow(entry: Entry): HTMLElement {
  const { offer } = entry;
  const sub = [offer.appName, offer.group, needs(entry) && `on ${needs(entry)}`].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'row selectable-row', 'data-ref': offer.ref },
    h(
      'button',
      { class: 'row-main link-row', disabled: !offer.enabled, title: offer.reason ?? '', onclick: () => void openAction(entry) },
      h('div', { class: 'row-title' }, offer.title),
      h('div', { class: 'row-sub' }, offer.enabled ? sub : `${sub} · ${offer.reason ?? 'unavailable'}`),
    ),
    h(
      'div',
      { class: 'row-end' },
      h(
        'button',
        { class: `btn sm ghost${isPinned(offer.ref) ? ' active' : ''}`, title: isPinned(offer.ref) ? 'Unpin from the menus' : 'Pin to the top of the menus', onclick: () => void togglePin(offer.ref) },
        isPinned(offer.ref) ? 'Pinned' : 'Pin',
      ),
    ),
  );
}

/** With no search: the actions for this page; with one: every matching action. */
function renderResults(): void {
  if (!status || status.state !== 'connected') return fill(resultsEl);
  if (query.trim()) {
    const found = search(catalog, query);
    fill(
      resultsEl,
      found.length ? h('div', { class: 'list' }, found.map(actionRow)) : h('div', { class: 'empty' }, `No action matches “${query}”.`),
    );
    return;
  }
  const forPage = page
    ? catalog
        .filter((e) => e.item?.type === 'text/url' && e.offer.enabled)
        .sort((a, b) => Number(isPinned(b.offer.ref)) - Number(isPinned(a.offer.ref)) || b.offer.rank - a.offer.rank)
        .slice(0, 5)
    : [];
  fill(resultsEl, forPage.length ? [h('div', { class: 'section-head' }, h('h2', {}, 'This page')), h('div', { class: 'list' }, forPage.map(actionRow))] : null);
}

async function remembered(ref: string): Promise<Values> {
  const key = `values:${ref}`;
  return ((await ext.storage.local.get(key))[key] ?? {}) as Values;
}

/** The input field the action needs, and how to read it into items. */
function inputFor(entry: Entry): { el: HTMLElement | null; items: () => Promise<BrowserItem[]> } {
  const item = entry.item;
  switch (inputKind(item)) {
    case 'none':
      return { el: null, items: async () => [] };
    case 'url': {
      const input = h('input', { id: 'input-url', class: 'input', type: 'url', value: page?.url ?? '', placeholder: 'https://…' });
      return {
        el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'input-url' }, 'Address'), input),
        items: async () => {
          if (!input.value.trim()) throw new Error('Enter an address');
          return [{ type: 'text/url', text: input.value.trim() }];
        },
      };
    }
    case 'text': {
      const area = h('textarea', { id: 'input-text', class: 'input textarea', rows: 4, placeholder: 'Type or paste text' });
      return {
        el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'input-text' }, 'Text'), area),
        items: async () => {
          if (!area.value) throw new Error('Enter some text');
          return [{ type: item!.type, text: area.value }];
        },
      };
    }
    case 'file': {
      const picker = h('input', { id: 'input-file', class: 'input', type: 'file', accept: accept(item!.type) });
      return {
        el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'input-file' }, 'File'), picker),
        items: async () => {
          const file = picker.files?.[0];
          if (!file) throw new Error('Choose a file');
          if (file.size > MAX_DATA) throw new Error(`It’s larger than ${MAX_DATA / 1024 / 1024} MB. Use Arcade on it from your file manager instead.`);
          const data = toBase64(new Uint8Array(await file.arrayBuffer()));
          return [{ type: fileType(item!.type, file.type), name: file.name, data }];
        },
      };
    }
  }
}

async function openAction(entry: Entry): Promise<void> {
  const [form, last] = await Promise.all([ask<FormAnswer>({ type: 'form', ref: entry.offer.ref }), remembered(entry.offer.ref)]);
  const input = inputFor(entry);
  const back = () => void home();
  fill(
    body,
    h(
      'div',
      { class: 'head' },
      h('button', { class: 'btn sm ghost', id: 'back', onclick: back }, '‹ Back'),
      h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, form.title), h('div', { class: 'app' }, form.app)),
    ),
    formView({
      form,
      remembered: last,
      input: input.el,
      onCancel: back,
      onRun: async (values) => {
        const items = await input.items();
        await ask<{ job: number }>({ type: 'run-items', ref: entry.offer.ref, items, values });
        query = '';
        await home();
      },
    }),
  );
  (body.querySelector('#input-text, #input-url, #input-file, input, select') as HTMLElement | null)?.focus();
}

// ---------------------------------------------------------------------------------------------------------------
// Views

async function home(): Promise<void> {
  const s = status!;
  const searchInput = h('input', {
    id: 'search',
    type: 'search',
    placeholder: 'Search every Arcade action',
    autocomplete: 'off',
    oninput: (e) => {
      query = (e.target as HTMLInputElement).value;
      renderResults();
    },
  });
  searchInput.value = query;
  fill(
    body,
    s.state === 'connected' ? h('label', { class: 'search-field' }, searchInput) : null,
    resultsEl,
    s.state === 'connected'
      ? h('div', { class: 'section-head' }, h('h2', {}, 'Recent'), h('button', { class: 'btn sm ghost', onclick: () => void ask({ type: 'dismiss' }) }, 'Clear finished'))
      : null,
    s.state === 'connected' ? jobsEl : null,
  );
  renderResults();
  renderJobs(s.jobs);
  searchInput.focus();
}

function render(s: Status): void {
  status = s;
  fill(
    root,
    h(
      'div',
      { class: 'head' },
      h('img', { src: 'icons/48.png', alt: '' }),
      h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, 'Arcade'), stateLine(s)),
      h('a', { class: 'btn sm ghost', href: 'options.html', target: '_blank', id: 'settings' }, 'Settings'),
    ),
    notices(s),
    body,
  );
}

async function load(): Promise<void> {
  const s = await ask<Status>({ type: 'status' });
  const first = status === null;
  render(s);
  if (s.state === 'connected') {
    [catalog, prefs] = await Promise.all([ask<{ entries: Entry[] }>({ type: 'catalog' }).then((r) => r.entries), ask<Prefs>({ type: 'prefs' })]);
  }
  if (first || !body.querySelector('form')) await home();
}

async function retry(): Promise<void> {
  await ask({ type: 'refresh-menus' });
  await load();
}

async function currentPage(): Promise<void> {
  if (params.has('tab')) return;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/i.test(tab.url)) page = { url: tab.url, title: tab.title ?? '' };
}

ext.runtime.onMessage.addListener((message: { type?: string; jobs?: Job[] }) => {
  if (message?.type === 'jobs' && message.jobs) {
    if (status) status.jobs = message.jobs;
    renderJobs(message.jobs);
  }
  if (message?.type === 'state' && !body.querySelector('form')) void load();
});

// Other apps' jobs (the file menu's) aren't followed by the background; look again while any is unfinished.
setInterval(() => {
  if (status?.state === 'connected' && status.jobs.some((j) => !isFinished(j))) {
    void ask<Status>({ type: 'status' }).then((s) => {
      status = s;
      renderJobs(s.jobs);
    });
  }
}, 1500);

currentPage()
  .then(load)
  .catch((e: Error) => fill(root, h('p', { class: 'error' }, e.message)));
