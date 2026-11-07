import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonForPath } from '../src/compare-files.ts';
const tab = (id, path, text) => ({ id, path, text, original: 'disk version', language: null });

test('comparison uses unsaved target buffers instead of reading their disk version', async () => {
  const left = tab('a', 'a.rs', 'unsaved original');
  const right = tab('b', 'b.rs', 'unsaved target');
  const result = await comparisonForPath(left, 'b.rs', [left, right], async () => { throw Error('Must not read disk'); });
  assert.equal(result.left.text, 'unsaved original');
  assert.equal(result.right.text, 'unsaved target');
  assert.notEqual(result.left, left);
  assert.notEqual(result.right, right);
  result.right.text = 'changed snapshot';
  assert.equal(right.text, 'unsaved target');
});

test('unopened files are read without adding tabs or changing source buffers', async () => {
  const left = tab('a', '', 'draft 🦀\r\n');
  const tabs = [left];
  let requested;
  const result = await comparisonForPath(left, 'nested/file.ts', tabs, async path => { requested = path; return 'target\ttext'; });
  assert.equal(requested, 'nested/file.ts');
  assert.equal(result.right.text, 'target\ttext');
  assert.equal(result.right.original, 'target\ttext');
  assert.equal(result.left.text, 'draft 🦀\r\n');
  assert.equal(tabs.length, 1);
});

test('failed comparison reads preserve tabs and propagate the file error', async () => {
  const left = tab('a', 'a.rs', 'keep edits');
  await assert.rejects(comparisonForPath(left, 'missing.rs', [left], async () => { throw Error('Missing file'); }), /Missing file/);
  assert.equal(left.text, 'keep edits');
});
