// What the settings page says about the connection to the Arcade helper, and what fixes it.

import type { Hello } from './protocol.ts';

export interface ConnectionStatus {
  state: 'unknown' | 'connected' | 'missing' | 'denied' | 'disconnected';
  detail: string;
  hello: Hello | null;
  tools: string;
}

/** What a connection state means and what fixes it, in the words the person reads. */
export function connectionWords(s: ConnectionStatus): { ok: boolean; title: string; fix: string } {
  if (s.state === 'connected') {
    const apps = (s.hello?.apps ?? []).filter((a) => a.installed).length;
    return { ok: true, title: `Connected · ${apps} Arcade app${apps === 1 ? '' : 's'}${s.hello?.helper ? ` · helper ${s.hello.helper}` : ''}`, fix: '' };
  }
  if (s.state === 'denied') return { ok: false, title: 'The Arcade helper refused this extension', fix: 'Only the official Arcade extension can use the helper. Install it from Arcade Tools’ Everywhere page.' };
  if (s.state === 'disconnected') return { ok: false, title: 'The Arcade helper stopped answering', fix: 'Open Arcade Tools once so it restarts the helper, then test again.' };
  return { ok: false, title: 'Arcade Tools isn’t set up on this computer', fix: 'Install Arcade Tools and open it once. It sets up the Arcade helper that this extension talks to. Then test again.' };
}
