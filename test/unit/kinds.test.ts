import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileTypeForName } from '../../src/kinds.ts';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/content-vectors.json', import.meta.url), 'utf8')) as {
  kinds: { path: string; kind: string }[];
};

test('file kinds match Link’s vectors', () => {
  for (const { path, kind } of vectors.kinds) assert.equal(fileTypeForName(path), `file/${kind}`, path);
});

test('Windows paths, names without an extension and dot files', () => {
  assert.equal(fileTypeForName('C:\\Users\\me\\Downloads\\report.PDF'), 'file/pdf');
  assert.equal(fileTypeForName('/home/me/Downloads/README'), 'file/any');
  assert.equal(fileTypeForName('/home/me/.bashrc'), 'file/any');
});
