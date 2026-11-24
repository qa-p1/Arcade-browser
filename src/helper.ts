// The connection to the Arcade helper over native messaging. The browser starts the helper when the port opens;
// requests are `{id, method, params}` and answers `{id, result}` or `{id, error: {code, message}}`.

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: (port: PortLike) => void): void };
  /** Firefox reports why a port closed here; Chromium uses `runtime.lastError`. */
  error?: { message?: string } | null;
}

export class HelperError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'HelperError';
  }
}

/**
 * - `unknown`: not tried yet
 * - `connected`: the helper answered
 * - `missing`: the browser found no host file (Arcade Tools isn't installed, or hasn't written it yet)
 * - `denied`: the helper or the browser refused this extension
 * - `disconnected`: the helper stopped; the next request starts it again
 */
export type ConnectionState = 'unknown' | 'connected' | 'missing' | 'denied' | 'disconnected';

/** How a closed port's message reads in Chromium and Firefox. */
export function classifyDisconnect(message: string): ConnectionState {
  const m = message.toLowerCase();
  if (m.includes('not found') || m.includes('no such native application') || m.includes('not exist')) return 'missing';
  if (m.includes('forbidden') || m.includes('not allowed') || m.includes('denied')) return 'denied';
  return 'disconnected';
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: HelperError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HelperOptions {
  /** Close the port after this long without a request in flight (the browser then stops the helper). */
  idleMs?: number;
  timeoutMs?: number;
}

export class HelperClient {
  state: ConnectionState = 'unknown';
  /** The browser's or helper's own words for the last failure. */
  detail = '';
  /** True while something (job tracking) needs the port kept open. */
  keepOpen: () => boolean = () => false;

  readonly #connect: () => PortLike;
  readonly #lastError: () => string | undefined;
  readonly #idleMs: number;
  readonly #timeoutMs: number;
  #port: PortLike | null = null;
  #next = 1;
  #pending = new Map<number, Pending>();
  #idle: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<(state: ConnectionState) => void>();

  constructor(connect: () => PortLike, lastError: () => string | undefined, options: HelperOptions = {}) {
    this.#connect = connect;
    this.#lastError = lastError;
    this.#idleMs = options.idleMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: ConnectionState, detail = ''): void {
    const changed = state !== this.state;
    this.state = state;
    this.detail = detail;
    if (changed) for (const l of this.#listeners) l(state);
  }

  #open(): PortLike {
    if (this.#port) return this.#port;
    let port: PortLike;
    try {
      port = this.#connect();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.#setState(classifyDisconnect(message), message);
      throw new HelperError(this.state, message);
    }
    this.#port = port;
    port.onMessage.addListener((message) => this.#receive(port, message));
    port.onDisconnect.addListener((p) => {
      const why = p?.error?.message || this.#lastError() || 'The Arcade helper stopped';
      this.#closed(port, why);
    });
    return port;
  }

  #receive(port: PortLike, message: unknown): void {
    if (port !== this.#port || typeof message !== 'object' || message === null) return;
    const m = message as { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
    if (typeof m.id !== 'number') {
      // The helper refuses a caller with one id-less error and closes.
      if (m.error) {
        const code = m.error.code === 'denied' ? 'denied' : 'disconnected';
        this.#fail(new HelperError(code, m.error.message ?? 'The Arcade helper refused'));
        this.#setState(code, m.error.message ?? '');
        this.#drop();
      }
      return;
    }
    const pending = this.#pending.get(m.id);
    if (!pending) return;
    this.#pending.delete(m.id);
    clearTimeout(pending.timer);
    this.#setState('connected');
    if (m.error) pending.reject(new HelperError(m.error.code ?? 'internal', m.error.message ?? 'The helper failed'));
    else pending.resolve(m.result);
    this.#scheduleIdle();
  }

  #closed(port: PortLike, why: string): void {
    if (port !== this.#port) return;
    this.#port = null;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    const state = classifyDisconnect(why);
    this.#setState(state, why);
    this.#fail(new HelperError(state, why));
  }

  #fail(error: HelperError): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }

  #drop(): void {
    const port = this.#port;
    this.#port = null;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    try {
      port?.disconnect();
    } catch {
      // Already closed.
    }
  }

  #scheduleIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#idle = null;
      if (this.#pending.size === 0 && !this.keepOpen()) this.#drop();
      else this.#scheduleIdle();
    }, this.#idleMs);
  }

  /** One request. Rejects with a HelperError whose code is the helper's (`denied`, `unsupported`, …) or the
   * connection's (`missing`, `disconnected`, `timeout`). */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.#timeoutMs): Promise<T> {
    let port: PortLike;
    try {
      port = this.#open();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HelperError('timeout', `The Arcade helper didn't answer ${method} in time`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        port.postMessage({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        const message = e instanceof Error ? e.message : String(e);
        this.#closed(port, message);
        reject(new HelperError(this.state, message));
      }
    });
  }

  /** Closes the port now (tests, and before the extension unloads). */
  close(): void {
    this.#fail(new HelperError('disconnected', 'closed'));
    this.#drop();
  }
}
