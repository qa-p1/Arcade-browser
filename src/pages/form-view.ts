// An action's options form, drawn from its card. Used by the right-click form window and by the popup.

import { collect, initialValues, supported, visible, type Values } from '../form.ts';
import type { Control, FormAnswer } from '../protocol.ts';
import { h } from './dom.ts';

export interface FormViewOptions {
  form: FormAnswer;
  remembered: Values;
  /** Shown before the options: what the action works on, when the popup asks for it. */
  input?: HTMLElement | null;
  /** Runs with the values to send; a thrown Error's message is shown under the form. */
  onRun: (values: Values) => Promise<void>;
  onCancel?: () => void;
  cancelLabel?: string;
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

export function formView({ form, remembered, input, onRun, onCancel, cancelLabel = 'Cancel' }: FormViewOptions): HTMLFormElement {
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
  const el = h(
    'form',
    {
      class: 'fields',
      onsubmit: (e) => {
        e.preventDefault();
        const { values: send, problems } = collect(form.options, values);
        for (const [key, field] of fields) {
          field.querySelector('.field-error')?.remove();
          if (problems[key]) field.append(h('div', { class: 'field-error' }, problems[key]));
        }
        if (Object.keys(problems).length) return;
        run.classList.add('busy');
        run.disabled = true;
        error.textContent = '';
        onRun(send).catch((err: Error) => {
          run.classList.remove('busy');
          run.disabled = false;
          error.textContent = err.message;
        });
      },
    },
    input ?? null,
    basic,
    advanced.length ? h('details', { class: 'advanced' }, h('summary', {}, 'More options'), h('div', { class: 'fields' }, advanced)) : null,
    skipped ? h('p', { class: 'muted t-small' }, 'Results go where Arcade puts them (set in Arcade’s settings).') : null,
    error,
    h('div', { class: 'actions' }, onCancel ? h('button', { class: 'btn', type: 'button', onclick: onCancel }, cancelLabel) : null, run),
  );
  sync();
  return el;
}
