// Settings: the choices the helper keeps for every Arcade menu (where results go, pinned and hidden actions, the
// app chosen for each job). They are the same in the file manager and the browser.

import { ask, ext } from '../api.ts';
import type { Prefs } from '../protocol.ts';
import { OMNIBOX_KEYWORD } from '../manifest.ts';
import { connectionWords, type ConnectionStatus } from '../connection.ts';
import type { Entry } from '../search.ts';
import type { PageSettings } from '../sites.ts';
import { fill, h } from './dom.ts';

const root = document.getElementById('root')!;
let titles = new Map<string, string>();

function titleOf(ref: string): string {
  return titles.get(ref) ?? ref;
}

async function save(prefs: Prefs): Promise<void> {
  render(await ask<Prefs>({ type: 'prefs-set', prefs }));
}

function list(name: string, refs: string[], button: string, change: (ref: string) => Prefs, empty: string): HTMLElement {
  return h(
    'section',
    { class: 'section', id: name },
    h('div', { class: 'section-head' }, h('h2', {}, name === 'pinned' ? 'Pinned to the top of the menus' : 'Removed from the menus')),
    refs.length
      ? h(
          'div',
          { class: 'list' },
          refs.map((ref) =>
            h(
              'div',
              { class: 'row', 'data-ref': ref },
              h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, titleOf(ref)), h('div', { class: 'row-sub mono' }, ref)),
              h('div', { class: 'row-end' }, h('button', { class: 'btn sm', onclick: () => void save(change(ref)) }, button)),
            ),
          ),
        )
      : h('p', { class: 'muted t-small' }, empty),
  );
}

/** The extension's own settings: they work without Arcade Tools, so they're shown even when it can't be reached. */
function browserSection(settings: PageSettings): HTMLElement {
  const row = (key: keyof PageSettings, label: string, desc: string) => {
    const box = h('input', { id: `setting-${key}`, type: 'checkbox', class: 'switch' });
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings = { ...settings, [key]: box.checked };
      void ask<PageSettings>({ type: 'settings-set', settings });
    });
    return h('label', { class: 'setting-row' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), h('div', { class: 'setting-desc' }, desc)), box);
  };
  return h(
    'section',
    { class: 'section', id: 'browser' },
    h('div', { class: 'section-head' }, h('h2', {}, 'In this browser')),
    h(
      'div',
      { class: 'list' },
      row('pageButtons', 'Buttons on sites', 'A Download button under videos on YouTube and other sites Arcade knows.'),
      row('hoverButtons', 'Button over pictures and videos', 'Point at a picture to see what your Arcade apps can do with it.'),
      row('downloadNotices', 'After a download', 'A notification with what Arcade can do with the file.'),
    ),
  );
}

let shortcut = '';

function connectionSection(): HTMLElement {
  const line = h('div', { class: 'state', id: 'connection-state' }, 'Not tested yet');
  const fix = h('p', { class: 'muted t-small', id: 'connection-fix' });
  // .btn sets its own display, so the hidden attribute alone wouldn't hide it.
  const get = h('a', { class: 'btn', id: 'get-tools', target: '_blank', rel: 'noreferrer', style: 'display:none' }, 'Get Arcade Tools');
  const test = h('button', {
    class: 'btn primary',
    id: 'test-connection',
    onclick: async () => {
      test.disabled = true;
      fill(line, 'Testing…');
      try {
        const words = connectionWords(await ask<ConnectionStatus>({ type: 'status' }));
        line.className = `state ${words.ok ? 'ok' : 'bad'}`;
        fill(line, h('span', { class: 'dot' }), words.title);
        fix.textContent = words.fix;
        get.style.display = words.ok ? 'none' : '';
      } catch (e) {
        line.className = 'state bad';
        fill(line, h('span', { class: 'dot' }), (e as Error).message);
      } finally {
        test.disabled = false;
      }
    },
  }, 'Test connection');
  void ask<ConnectionStatus>({ type: 'status' }).then((s) => { get.setAttribute('href', s.tools); }).catch(() => {});
  return h(
    'section',
    { class: 'section', id: 'connection' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connection')),
    h('div', { class: 'list' },
      h('div', { class: 'setting-row stacked' }, line, fix, h('div', { class: 'btn-group' }, test, get)),
      h('div', { class: 'setting-row stacked' },
        h('div', { class: 'setting-label' }, 'From the keyboard'),
        h('div', { class: 'setting-desc', id: 'keyboard-help' },
          shortcut ? `${shortcut} opens the Arcade button. ` : 'Set a key for the Arcade button in your browser’s extension shortcuts. ',
          `In the address bar, type ${OMNIBOX_KEYWORD} and a space, then what you want to do.`),
      ),
    ),
  );
}

let pageSettings: PageSettings | null = null;

function render(prefs: Prefs): void {
  const folder = h('input', { id: 'output-folder', class: 'input', type: 'text', placeholder: 'Each action’s own place (usually next to the file, or Downloads)', value: prefs.outputFolder ?? '' });
  const askWhere = h('input', { id: 'ask-where', type: 'checkbox', class: 'switch' });
  askWhere.checked = Boolean(prefs.askWhere);
  const defaults = Object.entries(prefs.defaults);
  fill(
    root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Arcade settings'), h('div', { class: 'sub' }, 'These apply to Arcade’s menus everywhere: your file manager and your browser.'))),
    connectionSection(),
    pageSettings ? browserSection(pageSettings) : null,
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Results')),
      h(
        'div',
        { class: 'list' },
        h(
          'div',
          { class: 'setting-row stacked' },
          h('label', { class: 'setting-label', for: 'output-folder' }, 'Save results in'),
          h('div', { class: 'btn-group' }, folder, h('button', { class: 'btn', id: 'save-folder', onclick: () => void save({ ...prefs, outputFolder: folder.value.trim() }) }, 'Save')),
          h('div', { class: 'setting-desc' }, 'A folder on this computer. Leave it empty for each action’s own place.'),
        ),
        h(
          'label',
          { class: 'setting-row' },
          h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Ask where to save every time')),
          askWhere,
        ),
      ),
    ),
    list('pinned', prefs.pinned, 'Unpin', (ref) => ({ ...prefs, pinned: prefs.pinned.filter((r) => r !== ref) }), 'Pin actions from the Arcade button’s search.'),
    list('hidden', prefs.hidden, 'Show again', (ref) => ({ ...prefs, hidden: prefs.hidden.filter((r) => r !== ref) }), 'Nothing is removed.'),
    h(
      'section',
      { class: 'section', id: 'defaults' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Apps chosen for a job')),
      defaults.length
        ? h(
            'div',
            { class: 'list' },
            defaults.map(([job, ref]) =>
              h(
                'div',
                { class: 'row', 'data-job': job },
                h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, titleOf(ref)), h('div', { class: 'row-sub mono' }, job)),
                h(
                  'div',
                  { class: 'row-end' },
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: () => {
                        const next = { ...prefs.defaults };
                        delete next[job];
                        void save({ ...prefs, defaults: next });
                      },
                    },
                    'Ask again',
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted t-small' }, 'When two apps can do the same job, the menus show both until you choose one.'),
    ),
  );
  askWhere.addEventListener('change', () => void save({ ...prefs, askWhere: askWhere.checked }));
}

async function load(): Promise<void> {
  pageSettings = await ask<PageSettings>({ type: 'settings' });
  shortcut = (await ext.commands.getAll().catch(() => [])).find((c) => c.name === '_execute_action')?.shortcut ?? '';
  try {
    const [prefs, catalog] = await Promise.all([ask<Prefs>({ type: 'prefs' }), ask<{ entries: Entry[] }>({ type: 'catalog' })]);
    titles = new Map(catalog.entries.map((e) => [e.offer.ref, `${e.offer.title} · ${e.offer.appName}`]));
    render(prefs);
  } catch (e) {
    fill(
      root,
      h('h1', {}, 'Arcade settings'),
      connectionSection(),
      browserSection(pageSettings),
      h('p', { class: 'error' }, `${(e as Error).message}. The other settings need Arcade Tools; open the Arcade button for help.`),
    );
  }
}

void load();
