// Firefox driven through its own WebDriver BiDi server (`--remote-debugging-port`), which can install a temporary
// add-on (`webExtension.install`): no geckodriver or Selenium needed.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Firefox {
  process: ChildProcess;
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Runs `expression` (an async function body's value) in a tab and returns its JSON result. */
  evaluate<T>(context: string, expression: string): Promise<T>;
  close(): Promise<void>;
}

/** The fixed internal UUID for the add-on, so its pages have a known address. */
export const ADDON_UUID = '5c6f3a12-6e7d-4a51-9a0b-2b7c3d4e5f60';

export async function launchFirefox(binary: string, profile: string, env: Record<string, string>, addonId: string): Promise<Firefox> {
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [addonId]: ADDON_UUID }))});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("browser.aboutwelcome.enabled", false);',
    ].join('\n') + '\n',
  );
  const child = spawn(binary, ['--profile', profile, '--remote-debugging-port=0', '--no-remote', '--headless'], {
    env: { ...env, MOZ_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`Firefox didn't start its BiDi server:\n${seen}`)), 60_000);
    const look = (chunk: Buffer) => {
      seen += chunk.toString();
      const m = seen.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stderr!.on('data', look);
    child.stdout!.on('data', look);
    child.on('exit', (code) => reject(new Error(`Firefox exited (${code}):\n${seen}`)));
  });
  const ws = new WebSocket(`${url}/session`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('BiDi connection failed'));
  });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; type: string; result?: unknown; error?: string; message?: string };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(`${msg.error}: ${msg.message}`));
    else p.resolve(msg.result);
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('session.new', { capabilities: {} });
  return {
    process: child,
    send,
    async evaluate<T>(context: string, expression: string): Promise<T> {
      const answer = await send<{ type: string; result?: { type: string; value?: string }; exceptionDetails?: { text: string } }>('script.evaluate', {
        expression: `(async () => JSON.stringify(await (async () => (${expression}))()))()`,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      if (answer.type === 'exception') throw new Error(answer.exceptionDetails?.text ?? 'script failed');
      const value = answer.result?.value;
      return (value === undefined ? undefined : JSON.parse(value)) as T;
    },
    async close() {
      try {
        await Promise.race([send('browser.close'), new Promise((r) => setTimeout(r, 5_000))]);
      } catch {
        // Closing.
      }
      ws.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
