// A throwaway Arcade install for the end-to-end tests: an isolated home, the real Arcade Box running in it, and
// the host files the real helper writes for the browsers found there.
//
//   ARCADE_HELPER  the arcade-helper binary (inside Arcade Tools' package)
//   ARCADE_BOX     Arcade Box's package (AppImage) or binary
//
// Without them the tests are skipped with a note, so `npm run e2e` never fails for want of the apps.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, openSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Fleet {
  root: string;
  env: Record<string, string>;
  helper: string;
  /** The Chromium settings folder the helper wrote its host file into. */
  chromiumProfile: string;
  /** The Firefox profile root (`~/.mozilla`) the helper wrote its host file into. */
  mozilla: string;
  stop(): Promise<void>;
}

export function missing(): string | null {
  const absent = ['ARCADE_HELPER', 'ARCADE_BOX'].filter((k) => !process.env[k] || !existsSync(process.env[k]!));
  return absent.length ? `set ${absent.join(' and ')} to run the end-to-end tests` : null;
}

/** Polls `probe` (which may be async) until it gives a truthy value. */
export async function wait<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined | null | false;
    try {
      value = await probe();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}


export async function startFleet(): Promise<Fleet> {
  const helper = process.env.ARCADE_HELPER!;
  const box = process.env.ARCADE_BOX!;
  const root = mkdtempSync(join(tmpdir(), 'arcade-browser-e2e-'));
  for (const d of ['home', 'config', 'data', 'cache', 'runtime', 'tmp', 'arcade']) mkdirSync(join(root, d), { recursive: true });
  chmodSync(join(root, 'runtime'), 0o700);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'),
    ARCADE_HOME: join(root, 'arcade'),
    ARCADE_NO_INSTALL_PROMPT: '1',
    APPIMAGE_EXTRACT_AND_RUN: '1',
    ARCADE_UNPACKED: '1',
    NO_AT_BRIDGE: '1',
    // As Arcade-Link's own end-to-end runs start Box: X11 and WebKit's software painting on a display with no
    // compositor.
    XDG_SESSION_TYPE: 'x11',
    GDK_BACKEND: 'x11',
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
  };
  // The display, and the key to it: xvfb-run (CI) protects its server with an X authority file.
  for (const key of ['DISPLAY', 'XAUTHORITY'] as const) if (process.env[key]) env[key] = process.env[key]!;
  // The browsers' settings folders, so the helper writes host files for both families.
  const chromiumProfile = join(root, 'config', 'chromium');
  const mozilla = join(root, 'home', '.mozilla');
  mkdirSync(chromiumProfile, { recursive: true });
  mkdirSync(mozilla, { recursive: true });

  const card = join(root, 'arcade', 'apps', 'arcade.box.json');
  // Box's own output, shown if it doesn't start.
  const log = openSync(join(root, 'box.log'), 'a');
  const boxProcess: ChildProcess = spawn(box, ['--background'], { env, stdio: ['ignore', log, log], detached: true });
  let exited = '';
  boxProcess.on('error', (e) => (exited = `could not start: ${e.message}`));
  boxProcess.on('exit', (code, signal) => (exited = `exited with ${signal ?? code}`));
  boxProcess.unref();
  // Box writes a short card at once and its full one (every tool) once it has started.
  try {
    await wait(
      'Arcade Box’s card',
      () => existsSync(card) && (JSON.parse(readFileSync(card, 'utf8')).actions ?? []).length > 50,
      120_000,
    );
  } catch (e) {
    const output = readFileSync(join(root, 'box.log'), 'utf8').split('\n').slice(-40).join('\n');
    const cardState = existsSync(card) ? `a card with ${(JSON.parse(readFileSync(card, 'utf8')).actions ?? []).length} actions` : 'no card';
    throw new Error(`${(e as Error).message} (Box ${exited || 'still running'}, ${cardState}). Box said:\n${output || '(nothing)'}`);
  } finally {
    closeSync(log);
  }

  const integrate = spawnSync(helper, ['integrate'], { env, encoding: 'utf8', timeout: 60_000 });
  if (integrate.status !== 0) throw new Error(`arcade-helper integrate failed: ${integrate.stderr || integrate.stdout}`);
  for (const host of [join(chromiumProfile, 'NativeMessagingHosts/dev.arcade.helper.json'), join(mozilla, 'native-messaging-hosts/dev.arcade.helper.json')]) {
    if (!existsSync(host)) throw new Error(`the helper wrote no ${host}`);
  }

  return {
    root,
    env,
    helper,
    chromiumProfile,
    mozilla,
    async stop() {
      spawnSync(helper, ['quit', '--force'], { env, timeout: 30_000 });
      try {
        if (boxProcess.pid) process.kill(-boxProcess.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      // The helper's progress window and anything else started in this home; one may start another as it goes,
      // so until nothing is left.
      for (let round = 0; round < 20; round++) {
        const left = processesIn(env.ARCADE_HOME!);
        if (left.length === 0) break;
        for (const pid of left) {
          try {
            process.kill(pid, round < 10 ? 'SIGTERM' : 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Processes whose environment points at this Arcade home (Linux; elsewhere the helper's own `quit` is relied on). */
function processesIn(arcadeHome: string): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `ARCADE_HOME=${arcadeHome}\0`;
  const out: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (`${readFileSync(`/proc/${pid}/environ`, 'latin1')}\0`.includes(marker)) out.push(pid);
    } catch {
      // Gone, or not ours to read.
    }
  }
  return out;
}
