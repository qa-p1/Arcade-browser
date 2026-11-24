// The options window for an action that isn't one click: the app's form, drawn from its card.

import { ask } from '../api.ts';
import { collect, initialValues, supported, visible, type Values } from '../form.ts';
import type { Target } from '../items.ts';
import type { MenuAction } from '../menus.ts';
import type { Control, FormAnswer } from '../protocol.ts';
import { fill, h } from './dom.ts';

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

function control(c: Control, values: Values, changed: () => void): HTMLElement {
  const id = `f-${c.key}`;
  const set = (value: unknown) => {
    values[c.key] = value;
    changed();
  };
  const help = c.help ? h('div', { class: 'help' }, c.help) : null;
  switch (c.type) {
    case 'toggle': {
      const box = h('input', { id, type: 'checkbox', class: 'switch', onchange: (e) => set((e.target as HTMLInputElement).checked) });
      box.checked = Boolean(values[c.key]);
      return h('div', { class: 'field toggle', 'data-key': c.key }, h('label', { for: id }, c.label, help), box);
    }
    case 'select': {
      const select = h(
        'select',
        { id, class: 'select', onchange: (e) => set((e.target as HTMLSelectElement).value) },
        (c.choices ?? []).map((choice) => h('option', { value: String(choice.value) }, choice.label)),
      );
      select.value = String(values[c.key] ?? '');
      return h('div', { class: 'field', 'data-key': c.key }, h('label', { class: 'field-label', for: id }, c.label), select, help);
    }
    default: {
      const type = c.type === 'number' ? 'number' : c.type === 'password' ? 'password' : c.type === 'color' ? 'color' : 'text';
      const input = h('input', {
        id,
        type,
        class: 'input',
        placeholder: c.placeholder,
        min: c.minimum,
        max: c.maximum,
        step: c.step,
        autocomplete: c.type === 'password' ? 'new-password' : 'off',
        oninput: (e) => set((e.target as HTMLInputElement).value),
      });
      input.value = values[c.key] === undefined ? '' : String(values[c.key]);
      return h('div', { class: 'field', 'data-key': c.key }, h('label', { class: 'field-label', for: id }, c.label), input, help);
    }
  }
}

function render({ pending, form, remembered }: PendingAnswer): void {
  document.title = `${form.title} · Arcade`;
  const controls = (form.options?.controls ?? []).filter(supported);
  const values = initialValues(form.options, remembered);
  const fields = new Map<string, HTMLElement>();
  const error = h('div', { class: 'error', role: 'alert' });
  const sync = () => {
    for (const c of controls) fields.get(c.key)!.hidden = !visible(c, values);
  };
  for (const c of controls) fields.set(c.key, control(c, values, sync));
  const basic = controls.filter((c) => !c.advanced).map((c) => fields.get(c.key)!);
  const advanced = controls.filter((c) => c.advanced).map((c) => fields.get(c.key)!);
  const skipped = (form.options?.controls ?? []).some((c) => c.type === 'directory' || c.type === 'file');
  const run = h('button', { class: 'btn primary', type: 'submit', id: 'run' }, 'Run');
  const formEl = h(
    'form',
    {
      class: 'fields',
      onsubmit: (e) => {
        e.preventDefault();
        const { values: send, problems } = collect(form.options, values);
        for (const [key, el] of fields) {
          el.querySelector('.field-error')?.remove();
          if (problems[key]) el.append(h('div', { class: 'field-error' }, problems[key]));
        }
        if (Object.keys(problems).length) return;
        run.classList.add('busy');
        run.disabled = true;
        error.textContent = '';
        ask<{ job: number }>({ type: 'run', token, values: send }).then(
          () => {
            fill(root, h('p', {}, `${form.title} started. A notification tells you when it’s done.`));
            setTimeout(() => window.close(), 900);
          },
          (e: Error) => {
            run.classList.remove('busy');
            run.disabled = false;
            error.textContent = e.message;
          },
        );
      },
    },
    basic,
    advanced.length ? h('details', { class: 'advanced' }, h('summary', {}, 'More options'), h('div', { class: 'fields' }, advanced)) : null,
    skipped ? h('p', { class: 'muted t-small' }, 'Results go where Arcade puts them (set in Arcade Tools).') : null,
    error,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => window.close() }, 'Cancel'), run),
  );
  fill(
    root,
    h(
      'div',
      { class: 'head' },
      h('img', { src: 'icons/48.png', alt: '' }),
      h('div', { class: 'titles' }, h('div', { class: 't-title-sm' }, form.title), h('div', { class: 'app' }, form.app)),
    ),
    h('div', { class: 'subject mono' }, subject(pending.target)),
    formEl,
  );
  sync();
  (formEl.querySelector('input, select') as HTMLElement | null)?.focus();
}

ask<PendingAnswer>({ type: 'pending', token }).then(render, (e: Error) => {
  fill(root, h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => window.close() }, 'Close')));
});
