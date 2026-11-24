// Following jobs: one long `jobs` call at a time (the helper answers when something changed or after 25 s), while
// a job this extension started is unfinished.

import { MAX_WAIT_MS, isFinished, type Job, type JobsAnswer } from './protocol.ts';

export type Request = <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export interface WatcherEvents {
  /** Every job the helper knows (the file menu's too), after each change. */
  onUpdate?: (jobs: Job[]) => void;
  /** A job this extension started reached done, failed or cancelled. */
  onFinished?: (job: Job) => void;
  /** The ids to remember across a background restart. */
  onTracked?: (ids: number[]) => void;
}

export class JobWatcher {
  readonly #request: Request;
  readonly #events: WatcherEvents;
  readonly #waitMs: number;
  readonly #retryMs: number;
  #revision = 0;
  #jobs = new Map<number, Job>();
  #mine = new Set<number>();
  #misses = new Map<number, number>();
  #loop: Promise<void> | null = null;
  #stopped = false;

  constructor(request: Request, events: WatcherEvents = {}, options: { waitMs?: number; retryMs?: number } = {}) {
    this.#request = request;
    this.#events = events;
    this.#waitMs = options.waitMs ?? MAX_WAIT_MS;
    this.#retryMs = options.retryMs ?? 2_000;
  }

  get jobs(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => b.id - a.id);
  }

  /** Jobs this extension started that haven't finished. */
  get running(): Job[] {
    return [...this.#mine].map((id) => this.#jobs.get(id)).filter((j): j is Job => Boolean(j) && !isFinished(j!));
  }

  /** True while a job of ours is unfinished or not yet seen. */
  get busy(): boolean {
    return [...this.#mine].some((id) => {
      const job = this.#jobs.get(id);
      return !job || !isFinished(job);
    });
  }

  /** Start following `id` (and any ids remembered from before a restart). */
  track(...ids: number[]): Promise<void> {
    for (const id of ids) this.#mine.add(id);
    this.#events.onTracked?.([...this.#mine]);
    return this.#start();
  }

  /** One immediate look, for the popup. */
  async refresh(): Promise<Job[]> {
    this.#apply(await this.#request<JobsAnswer>('jobs', { since: 0, waitMs: 0 }));
    return this.jobs;
  }

  stop(): void {
    this.#stopped = true;
  }

  #start(): Promise<void> {
    if (!this.#loop) {
      this.#loop = this.#run().finally(() => {
        this.#loop = null;
      });
    }
    return this.#loop;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped && this.busy) {
      try {
        const answer = await this.#request<JobsAnswer>('jobs', { since: this.#revision, waitMs: this.#waitMs }, this.#waitMs + 15_000);
        failures = 0;
        this.#apply(answer);
      } catch {
        failures += 1;
        if (failures >= 5) {
          // The helper is gone; the jobs went with it. Forget them so the badge doesn't spin forever.
          this.#mine.clear();
          this.#events.onTracked?.([]);
          return;
        }
        await new Promise((r) => setTimeout(r, this.#retryMs * failures));
      }
    }
  }

  #apply(answer: JobsAnswer): void {
    // A restarted helper counts revisions from zero again.
    this.#revision = answer.revision;
    const seen = new Set<number>();
    for (const job of answer.jobs) {
      seen.add(job.id);
      const before = this.#jobs.get(job.id);
      this.#jobs.set(job.id, job);
      if (this.#mine.has(job.id) && isFinished(job) && (!before || !isFinished(before))) {
        this.#events.onFinished?.(job);
      }
    }
    for (const id of [...this.#jobs.keys()]) if (!seen.has(id)) this.#jobs.delete(id);
    let forgot = false;
    for (const id of [...this.#mine]) {
      const job = this.#jobs.get(id);
      const misses = job ? 0 : (this.#misses.get(id) ?? 0) + 1;
      this.#misses.set(id, misses);
      // Finished and reported, or missing from three answers in a row (dismissed, or the helper restarted).
      if ((job && isFinished(job)) || misses >= 3) {
        this.#mine.delete(id);
        this.#misses.delete(id);
        forgot = true;
      }
    }
    if (forgot) this.#events.onTracked?.([...this.#mine]);
    this.#events.onUpdate?.(this.jobs);
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** A finished job in one line: "Saved cat.webp", the first text result, or why it failed. */
export function finishedMessage(job: Job): string {
  if (job.status === 'failed') return job.message || 'It didn’t work';
  if (job.status === 'cancelled') return 'Cancelled';
  const files = job.files ?? [];
  if (files.length) {
    const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
    return `Saved ${basename(files[0]!)}${more}${job.folder ? ` in ${job.folder}` : ''}`;
  }
  const text = (job.texts ?? [])[0];
  if (text) return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  return job.message || 'Done';
}
