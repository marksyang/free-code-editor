import { test } from 'node:test';
import assert from 'node:assert/strict';
import { range, markdown, serverKey, workspaceEdits, validateEdits } from '../src/lsp-protocol.ts';
import { editorReducer, initialSession } from '../src/editor-state.ts';
const edit = (start, end, newText = 'value') => ({ range: { start, end }, newText });
const p = (line, character) => ({ line, character });

test('LSP ranges validate zero-based UTF-16 positions and reject malformed coordinates', () => {
  assert.deepEqual(range({ start: p(0, 2), end: p(0, 4) }), { start: p(0, 2), end: p(0, 4) });
  assert.equal(range({ start: p(-1, 0), end: p(0, 0) }), null);
  assert.equal(range({ start: p(1, 0), end: p(0, 1) }), null);
  assert.equal(range({ start: p(0, 1.5), end: p(0, 2) }), null);
});

test('rename validation respects UTF-16, CRLF and non-overlapping text edits', () => {
  const text = '🦀 name\r\nsecond';
  assert.doesNotThrow(() => validateEdits(text, [edit(p(0, 3), p(0, 7)), edit(p(1, 0), p(1, 6))]));
  assert.throws(() => validateEdits(text, [edit(p(0, 1), p(0, 2))]), /surrogate/);
  assert.throws(() => validateEdits(text, [edit(p(0, 3), p(0, 8))]), /outside/);
  assert.throws(() => validateEdits(text, [edit(p(0, 3), p(0, 7)), edit(p(0, 4), p(0, 6))]), /Overlapping/);
});

test('workspace rename accepts text edits and refuses file operations or malformed edits', () => {
  const edits = [edit(p(0, 0), p(0, 1))];
  assert.equal(workspaceEdits({ changes: { 'file:///a.c': edits } })[0].version, null);
  assert.equal(workspaceEdits({ documentChanges: [{ textDocument: { uri: 'file:///a.c', version: 3 }, edits }] })[0].version, 3);
  assert.throws(() => workspaceEdits({ documentChanges: [{ kind: 'delete', uri: 'file:///a.c' }] }), /file operations/);
  assert.throws(() => workspaceEdits({ changes: { 'file:///a.c': [{ newText: 'bad' }] } }), /Invalid/);
  assert.throws(() => workspaceEdits({ changes: { 'file:///a.c': edits }, documentChanges: [] }), /Ambiguous/);
});

test('hover content never enables trusted command links or HTML', () => {
  for (const item of markdown(['[run](command:unsafe)', { kind: 'markdown', value: '<script>alert(1)</script>' }, { kind: 'plaintext', value: '*plain*' }])) {
    assert.equal(item.isTrusted, false); assert.equal(item.supportHtml, false);
  }
  assert.equal(markdown({ kind: 'plaintext', value: '*plain*' })[0].value, '\\*plain\\*');
});

test('LSP routes supported languages and keeps build/configuration modes as basic editing', () => {
  assert.equal(serverKey('c'), 'cpp'); assert.equal(serverKey('cpp'), 'cpp');
  for (const id of ['rust', 'javascript', 'json', 'python', 'perl', 'shell', 'css', 'html']) assert.equal(serverKey(id), id);
  assert.equal(serverKey('typescript'), 'javascript');
  for (const id of ['puppet', 'pascal', 'bitbake']) assert.equal(serverKey(id), null);
  assert.equal(serverKey('makefile'), null); assert.equal(serverKey('markdown'), null);
});

test('inserting rename buffers preserves focus and the disk baseline', () => {
  const first = { id: 'first', path: 'main.c', text: 'name', original: 'name', language: null };
  let state = editorReducer(initialSession, { type: 'open', tab: first });
  state = editorReducer(state, { type: 'insert', tab: { ...first, id: 'second', path: 'header.h' } });
  state = editorReducer(state, { type: 'edit', id: 'second', text: 'new_name' });
  assert.equal(state.active, 'first'); assert.equal(state.tabs[1].original, 'name');
  assert.equal(state.tabs[1].text, 'new_name');
});
