import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedMessage, JobWatcher } from '../../src/jobs.ts';
import type { Job, JobsAnswer } from '../../src/protocol.ts';

function job(id: number, status: Job['status'], extra: Partial<Job> = {}): Job {
  return { id, reference: 'arcade.box/x', title: `Job ${id}`, app: 'Arcade Box', status, inputs: 1, origin: 'browser', ...extra };
}

/** Answers `jobs` from a script of answers, one per call. */
function scripted(answers: JobsAnswer[]) {
  const calls: Record<string, unknown>[] = [];
  const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    assert.equal(method, 'jobs');
    calls.push(params);
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next as T;
  };
  return { request, calls };
}

test('follows a job until it finishes and reports it once', async () => {
  const { request, calls } = scripted([
    { revision: 1, jobs: [job(4, 'queued')] },
    { revision: 2, jobs: [job(4, 'running', { fraction: 0.5 })] },
    { revision: 3, jobs: [job(4, 'done', { texts: ['hello world'] }), job(3, 'done', { origin: 'file-manager' })] },
  ]);
  const finished: Job[] = [];
  const updates: number[] = [];
  const watcher = new JobWatcher(request, { onFinished: (j) => finished.push(j), onUpdate: (jobs) => updates.push(jobs.length) }, { waitMs: 5 });
  await watcher.track(4);
  assert.deepEqual(calls.map((c) => c.since), [0, 1, 2]);
  assert.deepEqual(finished.map((j) => j.id), [4], 'the file menu’s job is not ours');
  assert.deepEqual(updates, [1, 1, 2]);
  assert.equal(watcher.busy, false);
  assert.deepEqual(watcher.jobs.map((j) => j.id), [4, 3]);
});

test('a job already finished when first seen is still reported', async () => {
  const { request } = scripted([{ revision: 9, jobs: [job(1, 'failed', { message: 'libvips isn’t installed' })] }]);
  const finished: Job[] = [];
  await new JobWatcher(request, { onFinished: (j) => finished.push(j) }, { waitMs: 5 }).track(1);
  assert.equal(finished[0]!.status, 'failed');
});

test('a job missing from three answers is forgotten', async () => {
  const { request } = scripted([
    { revision: 1, jobs: [] },
    { revision: 1, jobs: [] },
    { revision: 1, jobs: [] },
  ]);
  const tracked: number[][] = [];
  const watcher = new JobWatcher(request, { onTracked: (ids) => tracked.push(ids) }, { waitMs: 5 });
  await watcher.track(7);
  assert.equal(watcher.busy, false);
  assert.deepEqual(tracked.at(-1), []);
});

test('a helper that keeps failing stops the loop and forgets the jobs', async () => {
  let n = 0;
  const watcher = new JobWatcher(
    async () => {
      n += 1;
      throw new Error('gone');
    },
    {},
    { waitMs: 5, retryMs: 1 },
  );
  await watcher.track(1);
  assert.equal(n, 5);
  assert.equal(watcher.busy, false);
});

test('one loop at a time', async () => {
  const { request, calls } = scripted([{ revision: 1, jobs: [job(1, 'done'), job(2, 'done')] }]);
  const watcher = new JobWatcher(request, {}, { waitMs: 5 });
  await Promise.all([watcher.track(1), watcher.track(2)]);
  assert.equal(calls.length, 1);
});

test('finished jobs in one line', () => {
  assert.equal(finishedMessage(job(1, 'done', { files: ['/home/u/Pictures/cat.webp'], folder: '/home/u/Pictures' })), 'Saved cat.webp in /home/u/Pictures');
  assert.equal(finishedMessage(job(1, 'done', { files: ['C:\\u\\a.png', 'C:\\u\\b.png'] })), 'Saved a.png and 1 more');
  assert.equal(finishedMessage(job(1, 'done', { texts: ['x'.repeat(300)] })).length, 178);
  assert.equal(finishedMessage(job(1, 'failed', { message: 'No network' })), 'No network');
  assert.equal(finishedMessage(job(1, 'done')), 'Done');
});
