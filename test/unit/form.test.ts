import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collect, initialValues, problem, rememberable, supported, visible } from '../../src/form.ts';
import type { FormAnswer, OptionsForm } from '../../src/protocol.ts';

const box = JSON.parse(readFileSync(new URL('../fixtures/box.json', import.meta.url), 'utf8'));
const downloader = (box.downloaderForm as FormAnswer).options!;

test('Box’s downloader form: defaults, and what shows for audio', () => {
  const values = initialValues(downloader);
  assert.equal(values.media, 'video');
  assert.equal(values.quality, 'best');
  assert.equal(values.metadata, true);
  assert.equal(values.subtitles, false);
  assert.equal('destinationGrant' in values, false, 'a folder picker is left to the app');
  const quality = downloader.controls.find((c) => c.key === 'quality')!;
  const audioFormat = downloader.controls.find((c) => c.key === 'audioFormat')!;
  assert.equal(visible(quality, values), true);
  assert.equal(visible(audioFormat, values), false);
  values.media = 'audio';
  assert.equal(visible(quality, values), false);
  assert.equal(visible(audioFormat, values), true);
  const sent = collect(downloader, values).values;
  assert.deepEqual(Object.keys(sent).sort(), ['audioFormat', 'audioQuality', 'media', 'metadata', 'subtitles', 'thumbnail']);
});

test('remembered values win where they still fit', () => {
  const values = initialValues(downloader, { media: 'audio', quality: '8K', subtitles: true, gone: 1 });
  assert.equal(values.media, 'audio');
  assert.equal(values.quality, 'best', 'a choice the form no longer has falls back');
  assert.equal(values.subtitles, true);
  assert.equal('gone' in values, false);
});

const form: OptionsForm = {
  version: 1,
  controls: [
    { key: 'width', label: 'Width', type: 'number', default: 800, minimum: 1, maximum: 10000 },
    { key: 'level', label: 'Level', type: 'select', choices: [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }] },
    { key: 'secret', label: 'Password', type: 'password' },
    { key: 'note', label: 'Note', type: 'text' },
    { key: 'mode', label: 'Mode', type: 'select', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
    { key: 'extra', label: 'Extra', type: 'text', showWhen: { key: 'mode', oneOf: ['b', 'c'] } },
    { key: 'spin', label: 'Spin', type: 'wheel' },
  ],
};

test('numbers are checked and sent as numbers; choices keep their type', () => {
  const values = initialValues(form);
  assert.equal(values.level, 1, 'a select without a default starts on its first choice');
  values.width = '1200';
  values.level = '2';
  values.note = '';
  values.secret = 'hunter2';
  const { values: sent, problems } = collect(form, values);
  assert.deepEqual(sent, { width: 1200, level: 2, secret: 'hunter2', mode: 'a' });
  assert.deepEqual(problems, {});
  assert.equal(problem(form.controls[0]!, '0'), 'At least 1');
  assert.equal(problem(form.controls[0]!, 'abc'), 'Enter a number');
  assert.deepEqual(collect(form, { ...values, width: '20000' }).problems, { width: 'At most 10000' });
});

test('oneOf conditions, unknown types and passwords', () => {
  assert.equal(visible(form.controls[5]!, { mode: 'b' }), true);
  assert.equal(visible(form.controls[5]!, { mode: 'a' }), false);
  assert.equal(supported(form.controls[6]!), false);
  assert.deepEqual(Object.keys(rememberable(form, { width: 5, secret: 'x', spin: 1 })), ['width']);
  assert.equal(initialValues(form, { secret: 'remembered?' }).secret, undefined);
});
