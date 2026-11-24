// The toolbar popup: whether Arcade is connected, and the recent jobs with their results.

import { ask, ext } from '../api.ts';
import type { ConnectionState } from '../helper.ts';
import { finishedMessage } from '../jobs.ts';
import { isFinished, type Hello, type Job } from '../protocol.ts';
import { fill, h } from './dom.ts';

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
const focusJob = Number(new URLSearchParams(location.hash.slice(1)).get('job') ?? 0);
if (new URLSearchParams(location.search).has('tab')) root.classList.replace('popup', 'wide');

let status: Status | null = null;
const jobsEl = h('div', { class: 'list', id: 'jobs' });

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
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () =>
              void ext.permissions.request({ origins: ['<all_urls>'] }).then(() => void retry()),
          },
          'Allow',
        ),
      ),
    );
  }
  return out;
}

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
      texts.map((text) =>
        h(
          'div',
          { class: 'job-text mono' },
          text,
        ),
      ),
      files.length > 1 ? h('div', { class: 'row-sub mono' }, files.join('\n')) : null,
    ),
    h(
      'div',
      { class: 'row-end' },
      texts.length
        ? h('button', { class: 'btn sm', onclick: () => void navigator.clipboard.writeText(texts[0]!) }, 'Copy')
        : null,
      running
        ? h('button', { class: 'btn sm ghost', onclick: () => void ask({ type: 'cancel', job: job.id }) }, 'Cancel')
        : h('button', { class: 'btn sm ghost', title: 'Remove from the list', onclick: () => void ask({ type: 'dismiss', job: job.id }) }, 'Clear'),
    ),
  );
}

function renderJobs(jobs: Job[]): void {
  const recent = jobs.slice(0, 20);
  if (recent.length === 0) fill(jobsEl, h('div', { class: 'empty' }, 'Right-click a picture, a link, selected text or the page to use your Arcade apps.'));
  else fill(jobsEl, recent.map(jobRow));
}

function render(s: Status): void {
  status = s;
  fill(
    root,
    h('div', { class: 'head' }, h('img', { src: 'icons/48.png', alt: '' }), h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, 'Arcade'), stateLine(s))),
    notices(s),
    s.state === 'connected' ? h('div', { class: 'section-head' }, h('h2', {}, 'Recent'), h('button', { class: 'btn sm ghost', onclick: () => void ask({ type: 'dismiss' }) }, 'Clear finished')) : null,
    s.state === 'connected' ? jobsEl : null,
  );
  renderJobs(s.jobs);
}

async function load(): Promise<void> {
  render(await ask<Status>({ type: 'status' }));
}

async function retry(): Promise<void> {
  await ask({ type: 'refresh-menus' });
  await load();
}

ext.runtime.onMessage.addListener((message: { type?: string; jobs?: Job[] }) => {
  if (message?.type === 'jobs' && message.jobs) renderJobs(message.jobs);
  if (message?.type === 'state') void load();
});

// Other apps' jobs (the file menu's) aren't followed by the background; look again while any is unfinished.
setInterval(() => {
  if (status?.state === 'connected' && status.jobs.some((j) => !isFinished(j))) void load();
}, 1500);

load().catch((e: Error) => fill(root, h('p', { class: 'error' }, e.message)));
