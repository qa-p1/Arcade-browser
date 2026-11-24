// An action's options form as data (Link SPEC §3, "Options form"): which controls show, their starting values,
// and what is sent. Drawing it is pages/form.ts; this part is shared and tested on its own.

import type { Control, OptionsForm } from './protocol.ts';

export type Values = Record<string, unknown>;

/** Controls a browser can fill. `directory` and `file` need a path picker the browser doesn't give an extension,
 * so they are left to the app's default (where results go is the helper's setting), like unknown types. */
const SUPPORTED = new Set(['text', 'number', 'select', 'toggle', 'password', 'color']);

export function supported(control: Control): boolean {
  return SUPPORTED.has(control.type);
}

function same(a: unknown, b: unknown): boolean {
  return a === b || String(a) === String(b);
}

/** A control shows when its `showWhen` condition holds against the current values. */
export function visible(control: Control, values: Values): boolean {
  const when = control.showWhen;
  if (!when) return true;
  const value = values[when.key];
  if (Array.isArray(when.oneOf)) return when.oneOf.some((v) => same(v, value));
  if ('equals' in when) return same(when.equals, value);
  return true;
}

function valid(control: Control, value: unknown): boolean {
  switch (control.type) {
    case 'select':
      return (control.choices ?? []).some((c) => same(c.value, value));
    case 'toggle':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'color':
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    default:
      return typeof value === 'string';
  }
}

/** The form's defaults, with the values the user chose last time where they still fit the form. Passwords are
 * never remembered. */
export function initialValues(form: OptionsForm | null | undefined, remembered: Values = {}): Values {
  const values: Values = {};
  for (const control of form?.controls ?? []) {
    if (!supported(control)) continue;
    const last = remembered[control.key];
    if (control.type !== 'password' && last !== undefined && valid(control, last)) values[control.key] = last;
    else if (control.default !== undefined) values[control.key] = control.default;
    else if (control.type === 'toggle') values[control.key] = false;
    else if (control.type === 'select' && control.choices?.length) values[control.key] = control.choices[0]!.value;
  }
  return values;
}

/** A problem with one value, or nothing. */
export function problem(control: Control, value: unknown): string | null {
  if (control.type !== 'number') return null;
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (control.minimum !== undefined && n < control.minimum) return `At least ${control.minimum}`;
  if (control.maximum !== undefined && n > control.maximum) return `At most ${control.maximum}`;
  return null;
}

/** What is sent: the visible, supported controls' values (numbers as numbers, empty text left out so the app's
 * default applies). Problems by key when a value can't be sent. */
export function collect(form: OptionsForm | null | undefined, values: Values): { values: Values; problems: Record<string, string> } {
  const out: Values = {};
  const problems: Record<string, string> = {};
  for (const control of form?.controls ?? []) {
    if (!supported(control) || !visible(control, values)) continue;
    const value = values[control.key];
    const p = problem(control, value);
    if (p) {
      problems[control.key] = p;
      continue;
    }
    if (value === undefined || value === null || value === '') continue;
    if (control.type === 'number') out[control.key] = Number(value);
    else if (control.type === 'select') {
      // Choices keep their own type (a number or a boolean stays one).
      const choice = (control.choices ?? []).find((c) => same(c.value, value));
      out[control.key] = choice ? choice.value : value;
    } else out[control.key] = value;
  }
  return { values: out, problems };
}

/** The values worth remembering for next time (never passwords). */
export function rememberable(form: OptionsForm | null | undefined, values: Values): Values {
  const out: Values = {};
  for (const control of form?.controls ?? []) {
    if (supported(control) && control.type !== 'password' && values[control.key] !== undefined) out[control.key] = values[control.key];
  }
  return out;
}
