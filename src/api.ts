// The browser's extension API: Firefox's promise-based `browser`, else Chromium's `chrome` (promise-based in MV3
// for everything used here). Both builds use the Chromium names, which Firefox also provides.

import type { BrowserItem, Prefs } from './protocol.ts';
import type { PageSettings } from './sites.ts';

declare const __TARGET__: 'chromium' | 'firefox';

export const ext: typeof chrome = ((globalThis as { browser?: typeof chrome }).browser ?? (globalThis as { chrome?: typeof chrome }).chrome)!;

export const TARGET: 'chromium' | 'firefox' = typeof __TARGET__ === 'string' ? __TARGET__ : 'chromium';

/** Messages the pages send the background. */
export type PageMessage =
  | { type: 'status' }
  | { type: 'pending'; token: string }
  | { type: 'run'; token: string; values: Record<string, unknown> }
  | { type: 'cancel'; job: number }
  | { type: 'dismiss'; job?: number }
  | { type: 'install'; app: string }
  | { type: 'refresh-menus' }
  | { type: 'catalog' }
  | { type: 'form'; ref: string }
  | { type: 'run-items'; ref: string; items: BrowserItem[]; values: Record<string, unknown> }
  | { type: 'prefs' }
  | { type: 'prefs-set'; prefs: Prefs }
  | { type: 'settings' }
  | { type: 'settings-set'; settings: PageSettings }
  | { type: 'download'; token: string }
  | { type: 'download-run'; token: string; ref: string; values: Record<string, unknown> };

/** Sends a message to the background and waits for its answer; an `{error}` answer becomes a thrown Error. */
export async function ask<T>(message: PageMessage): Promise<T> {
  const answer = (await ext.runtime.sendMessage(message)) as T | { error: string } | undefined;
  if (answer && typeof answer === 'object' && 'error' in answer && typeof answer.error === 'string') throw new Error(answer.error);
  return answer as T;
}
