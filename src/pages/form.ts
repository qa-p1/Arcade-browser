// The options window for an action that isn't one click: the app's form, drawn from its card.

import { ask } from '../api.ts';
import type { Values } from '../form.ts';
import type { Target } from '../items.ts';
import type { MenuAction } from '../menus.ts';
import type { FormAnswer } from '../protocol.ts';
import { fill, h } from './dom.ts';
import { formView } from './form-view.ts';

interface PendingAnswer {
  pending: { action: Extract<MenuAction, { kind: 'run' }>; target: Target };
  form: FormAnswer;
  remembered: Values;
}

const root = document.getElementById('root')!;
const token = location.hash.slice(1);

function subject(target: Target): string {
  if (target.context === 'selection') return `“${(target.selectionText ?? '').slice(0, 300)}”`;
  if (target.context === 'link' || target.context === 'pdf-link') return target.linkUrl ?? '';
  if (target.context === 'image' || target.context === 'video' || target.context === 'audio') {
    return target.srcUrl && !target.srcUrl.startsWith('data:') ? target.srcUrl : (target.pageUrl ?? '');
  }
  return target.pageUrl ?? '';
}

function render({ pending, form, remembered }: PendingAnswer): void {
  document.title = `${form.title} · Arcade`;
  const el = formView({
    form,
    remembered,
    onCancel: () => window.close(),
    onRun: async (values) => {
      await ask<{ job: number }>({ type: 'run', token, values });
      fill(root, h('p', {}, `${form.title} started. A notification tells you when it’s done.`));
      setTimeout(() => window.close(), 900);
    },
  });
  fill(
    root,
    h(
      'div',
      { class: 'head' },
      h('img', { src: 'icons/48.png', alt: '' }),
      h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, form.title), h('div', { class: 'app' }, form.app)),
    ),
    h('div', { class: 'subject mono' }, subject(pending.target)),
    el,
  );
  (el.querySelector('input, select') as HTMLElement | null)?.focus();
}

ask<PendingAnswer>({ type: 'pending', token }).then(render, (e: Error) => {
  fill(root, h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => window.close() }, 'Close')));
});
