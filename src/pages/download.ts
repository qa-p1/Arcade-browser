// What Arcade can do with a file that just finished downloading: the list behind the download notification.

import { ask, ext } from '../api.ts';
import type { Values } from '../form.ts';
import type { FormAnswer } from '../protocol.ts';
import { fill, h } from './dom.ts';
import { formView } from './form-view.ts';

interface DownloadOffer {
  ref: string;
  title: string;
  appName: string;
  oneClick: boolean;
}

const root = document.getElementById('root')!;
const token = location.hash.slice(1);

function head(name: string, sub: string): HTMLElement {
  return h(
    'div',
    { class: 'head' },
    h('img', { src: 'icons/48.png', alt: '' }),
    h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, sub), h('div', { class: 'app mono' }, name)),
  );
}

function started(title: string): void {
  fill(root, h('p', {}, `${title} started. A notification tells you when it’s done.`));
  setTimeout(() => window.close(), 900);
}

async function choose(name: string, offer: DownloadOffer, all: DownloadOffer[]): Promise<void> {
  if (offer.oneClick) {
    await ask<{ job: number }>({ type: 'download-run', token, ref: offer.ref, values: {} });
    started(offer.title);
    return;
  }
  const form = await ask<FormAnswer>({ type: 'form', ref: offer.ref });
  const key = `values:${offer.ref}`;
  // The background keeps each action's last options here.
  const remembered = ((await ext.storage.local.get(key))[key] ?? {}) as Values;
  const el = formView({
    form,
    remembered,
    cancelLabel: 'Back',
    onCancel: () => list(name, all),
    onRun: async (values) => {
      await ask<{ job: number }>({ type: 'download-run', token, ref: offer.ref, values });
      started(form.title);
    },
  });
  fill(root, head(name, form.title), el);
  (el.querySelector('input, select') as HTMLElement | null)?.focus();
}

function list(name: string, offers: DownloadOffer[]): void {
  document.title = `${name} · Arcade`;
  const error = h('div', { class: 'error', role: 'alert' });
  fill(
    root,
    head(name, 'Downloaded'),
    h(
      'div',
      { class: 'list' },
      offers.map((offer) =>
        h(
          'button',
          {
            class: 'row link-row',
            type: 'button',
            'data-ref': offer.ref,
            onclick: () => {
              error.textContent = '';
              choose(name, offer, offers).catch((e: Error) => (error.textContent = e.message));
            },
          },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, offer.title), h('div', { class: 'row-sub' }, offer.appName)),
        ),
      ),
    ),
    error,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => window.close() }, 'Close')),
  );
}

ask<{ name: string; offers: DownloadOffer[] }>({ type: 'download', token }).then(
  ({ name, offers }) => list(name, offers),
  (e: Error) => fill(root, h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => window.close() }, 'Close'))),
);
