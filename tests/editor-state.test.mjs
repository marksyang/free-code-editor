import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialSession, editorReducer, isDirty, normalizeSession, fuzzyPaths } from '../src/editor-state.ts';
import { continueMarkdownList } from '../src/markdown-edit.ts';
const tab = { id: 'one', path: 'a.md', text: 'old', original: 'old', language: null };

test('save completion preserves edits typed while the write was pending', () => {
  let state = editorReducer(initialSession, { type: 'open', tab });
  state = editorReducer(state, { type: 'edit', id: 'one', text: 'submitted' });
  state = editorReducer(state, { type: 'edit', id: 'one', text: 'newer' });
  state = editorReducer(state, { type: 'saved', id: 'one', path: 'a.md', text: 'submitted' });
  assert.equal(state.tabs[0].text, 'newer');
  assert.equal(state.tabs[0].original, 'submitted');
  assert.equal(isDirty(state.tabs[0]), true);
});

test('recovery preserves dirty/new tabs but rejects duplicates and malformed entries', () => {
  const recovered = normalizeSession({ ...initialSession, active: 'missing', tabs: [
    { ...tab, text: 'unsaved' }, tab,
    { ...tab, id: 'new', path: '', original: null, text: '' },
    { id: 'broken' },
  ] });
  assert.equal(recovered.tabs.length, 2);
  assert.equal(recovered.active, 'one');
  assert.equal(isDirty(recovered.tabs[0]), true);
  assert.equal(isDirty(recovered.tabs[1]), true);
  assert.equal(normalizeSession({ version: 99, root: '', tabs: [] }), null);
});

test('split views share the same tab without duplicating buffers', () => {
  let state = editorReducer(initialSession, { type: 'open', tab });
  state = editorReducer(state, { type: 'setting', key: 'split', value: true });
  state = editorReducer(state, { type: 'open', tab, pane: 'secondary' });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.active, state.secondary);
  state = editorReducer(state, { type: 'close', id: tab.id });
  assert.equal(state.active, '');
  assert.equal(state.secondary, '');
});

test('quick open matches subsequences and prioritizes basename prefixes', () => {
  const matches = fuzzyPaths(['src/main.tsx', 'src/monaco.ts', 'tests/main.test.mjs'], 'mnt');
  assert(matches.includes('src/main.tsx'));
  assert.equal(fuzzyPaths(['src/domain.ts', 'src/main.ts'], 'main')[0], 'src/main.ts');
  assert.deepEqual(fuzzyPaths(['a.md'], 'xyz'), []);
});

test('Markdown Enter continues lists, resets checkboxes, and exits empty items', () => {
  assert.equal(continueMarkdownList('  - [x] done', '').prefix, '  - [ ] ');
  assert.equal(continueMarkdownList('9. nine', '').prefix, '10. ');
  assert.equal(continueMarkdownList('  - ', '').removeEmptyMarker, true);
  assert.equal(continueMarkdownList('- example', '```sh\n'), null);
  assert.equal(continueMarkdownList('- example', '```sh\ncode\n```\n').prefix, '- ');
});

test('discarded edits are not resurrected by the close checkpoint', async () => {
  const { closeSnapshot } = await import('../src/editor-state.ts');
  const state = { ...initialSession, tabs: [
    { ...tab, text: 'discard me' },
    { ...tab, id: 'new', path: '', text: 'new unsaved', original: null },
    { ...tab, id: 'keep', path: 'keep.md', text: 'keep me' },
  ], active: 'new' };
  const checkpoint = closeSnapshot(state, new Set(['one', 'new']));
  assert.equal(checkpoint.tabs.length, 2);
  assert.equal(checkpoint.tabs[0].text, 'old');
  assert.equal(checkpoint.tabs[1].text, 'keep me');
  assert.equal(checkpoint.active, 'one');
  assert.equal(state.tabs[0].text, 'discard me');
});

test('recovery refreshes clean files while preserving dirty and deleted buffers', async () => {
  const { recoverTab } = await import('../src/editor-state.ts');
  assert.equal(recoverTab(tab, 'disk update').tab.text, 'disk update');
  const dirty = { ...tab, text: 'my unsaved edits' };
  const recovered = recoverTab(dirty, 'external update');
  assert.equal(recovered.conflict, true);
  assert.equal(recovered.tab.original, 'old');
  assert.equal(recovered.tab.text, 'my unsaved edits');
  assert.equal(recoverTab(dirty, null).tab.original, null);
  assert.equal(recoverTab(dirty, null).tab.text, 'my unsaved edits');
});
