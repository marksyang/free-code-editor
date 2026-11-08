import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSession, normalizeSession, editorReducer, recoverTab, closeSnapshot } from '../src/editor-state.ts';

test('legacy encodings survive save, reload, recovery and discard snapshots', () => {
  for (const encoding of ['big5', 'gbk', 'gb18030']) {
    const tab = { id: 'one', path: 'log.txt', text: '上午\r\n', original: '下午\r\n', language: null, encoding };
    const state = { ...initialSession, tabs: [tab], active: tab.id, minimap: false };
    const normalized = normalizeSession(JSON.parse(JSON.stringify(state)));
    assert.equal(normalized.tabs[0].encoding, encoding);
    assert.equal(normalized.minimap, false);
    const saved = editorReducer(normalized, { type: 'saved', id: tab.id, path: tab.path, text: tab.text, encoding });
    assert.equal(saved.tabs[0].encoding, encoding);
    assert.equal(recoverTab(tab, tab.original).tab.encoding, encoding);
    assert.equal(closeSnapshot(state, new Set([tab.id])).tabs[0].encoding, encoding);
    const reloaded = editorReducer(saved, { type: 'reload', id: tab.id, text: '中文', encoding: 'utf8' });
    assert.equal(reloaded.tabs[0].encoding, 'utf8');
  }
});
test('old UTF-8 sessions remain compatible and unknown encoding metadata is rejected', () => {
  const tab = { id: 'one', path: 'code.c', text: 'text', original: 'text', language: null };
  assert.equal(normalizeSession({ ...initialSession, tabs: [tab] }).tabs.length, 1);
  assert.equal(normalizeSession({ ...initialSession, tabs: [{ ...tab, encoding: 'made-up' }] }).tabs.length, 0);
});
