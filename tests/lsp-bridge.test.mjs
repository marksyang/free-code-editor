import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
let typescript;
try { typescript = await import('typescript'); } catch { /* These adapter checks require the installed compiler. */ }

async function fixture(t, overrides = {}) {
  if (!typescript) { t.skip('TypeScript is not installed'); return null; }
  const providers = {}, models = new Map(), created = [], calls = [], markers = new Map(), statuses = [];
  let sequence = 0, callbacks, id = 0;
  const state = { root: '/workspace', tabs: [{ id: 'main', path: 'main.c', text: 'int name;', original: 'int name;', language: null }], active: 'main' };
  const modes = {};
  const defaults = key => ({ modeConfiguration: { completionItems: true, hovers: true }, setModeConfiguration(config) { modes[key] = config; } });
  const empty = () => ({ dispose() {} });
  const uri = value => ({ scheme: value.split(':')[0], toString: () => value });
  class Model {
    constructor(text, language, resource) { this.text = text; this.language = language; this.uri = resource; this.version = 1; this.listeners = []; this.destroy = []; this.dead = false; }
    getValue() { return this.text; }
    getVersionId() { return this.version; }
    getLanguageId() { return this.language; }
    getWordUntilPosition(p) { return { startColumn: 1, endColumn: p.column, word: this.text.slice(0, p.column - 1) }; }
    isDisposed() { return this.dead; }
    setValue(text) { this.text = text; this.version++; this.listeners.forEach(fn => fn()); }
    onDidChangeContent(fn) { this.listeners.push(fn); return empty(); }
    onWillDispose(fn) { this.destroy.push(fn); return empty(); }
    dispose() { this.dead = true; this.destroy.forEach(fn => fn()); models.delete(this.uri.toString()); }
  }
  const languageApi = {
    typescript: { javascriptDefaults: defaults('javascript'), typescriptDefaults: defaults('typescript') }, json: { jsonDefaults: defaults('json') }, css: { cssDefaults: defaults('css') }, html: { htmlDefaults: defaults('html') },
    CompletionItemKind: new Proxy({}, { get: () => 1 }), CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  };
  for (const name of ['CompletionItem', 'Hover', 'Definition', 'Reference', 'Rename']) {
    languageApi[`register${name}Provider`] = (language, provider) => { providers[`${language}:${name}`] = provider; return empty(); };
  }
  const monaco = {
    languages: languageApi, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }, Uri: { parse: uri },
    Range: class { constructor(a, b, c, d) { this.startLineNumber = a; this.startColumn = b; this.endLineNumber = c; this.endColumn = d; } },
    editor: {
      getModels: () => [...models.values()], getModel: resource => models.get(resource.toString()),
      createModel(text, language, resource) { const model = new Model(text, language, resource); models.set(resource.toString(), model); created.forEach(fn => fn(model)); return model; },
      onDidCreateModel(fn) { created.push(fn); return empty(); }, registerEditorOpener: empty,
      setModelMarkers(model, _owner, values) { markers.set(model.uri.toString(), values); },
    },
  };
  const invoke = async (command, args = {}) => {
    calls.push({ command, args });
    if (overrides.invoke) { const result = overrides.invoke(command, args); if (result !== undefined) return result; }
    if (command === 'start_lsp') { callbacks = args.onEvent; return { serverId: '1', capabilities: { hoverProvider: true, completionProvider: {}, definitionProvider: true, referencesProvider: true, renameProvider: true } }; }
    if (command === 'sync_lsp_document') return { uri: `file:///workspace/${args.path}`, version: ++sequence };
    if (command === 'lsp_document_path') return args.uri.replace('file:///workspace/', '');
    if (command === 'read_file') return 'int name;';
    if (command === 'lsp_request') return { contents: 'hover' };
    return null;
  };
  globalThis.__lspAdapter = { monaco, invoke, Channel: class {} };
  const source = readFileSync(new URL('../src/lsp-bridge.ts', import.meta.url), 'utf8');
  let js = typescript.transpileModule(source, { compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ESNext } }).outputText;
  js = js.replace(/import \{ Channel, invoke \} from '@tauri-apps\/api\/core';/, 'const { Channel, invoke } = globalThis.__lspAdapter;')
    .replace(/import \{ monaco \} from '\.\/monaco';/, 'const { monaco } = globalThis.__lspAdapter;')
    .replaceAll("'./languages'", JSON.stringify(new URL('../src/languages.ts', import.meta.url).href))
    .replaceAll("'./lsp-protocol'", JSON.stringify(new URL('../src/lsp-protocol.ts', import.meta.url).href));
  const { LspBridge } = await import(`data:text/javascript;base64,${Buffer.from(js + `\n// fixture ${Math.random()}`).toString('base64')}`);
  const client = new LspBridge({
    state: () => state,
    change: (id, text) => { state.tabs.find(t => t.id === id).text = text; },
    read: overrides.read,
    insert(path, text, encoding) { let tab = state.tabs.find(t => t.path === path); if (!tab) { tab = { id: `insert-${++id}`, path, text, original: text, language: null, ...(encoding ? { encoding } : {}) }; state.tabs.push(tab); } return tab; },
    open: async () => {},
  }, status => statuses.push(status));
  client.register();
  const settings = { enabled: true, servers: { cpp: { enabled: true, executable: 'fake', args: [], env: {} } } };
  client.configure(settings, state.root);
  const model = monaco.editor.createModel(state.tabs[0].text, 'c', uri('editor://workspace/%252Fworkspace/main'));
  const token = { isCancellationRequested: false, onCancellationRequested: empty };
  t.after(() => { client.dispose(); delete globalThis.__lspAdapter; });
  return { client, settings, model, models, createModel: monaco.editor.createModel, providers, token, state, calls, markers, statuses, modes, events: () => callbacks };
}
async function waitFor(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(2); } throw new Error('Adapter check timed out'); }

test('hover responses are discarded when the buffer changes during the request', async t => {
  let resolve;
  const f = await fixture(t, { invoke(command) { if (command === 'lsp_request') return new Promise(done => { resolve = done; }); } });
  if (!f) return;
  const pending = f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 5 }, f.token);
  await waitFor(() => resolve);
  f.model.setValue('new text'); resolve({ contents: 'stale hover' });
  assert.equal(await pending, undefined);
});

test('diagnostics match the acknowledged document version and clear as soon as typing resumes', async t => {
  const f = await fixture(t); if (!f) return;
  await f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 5 }, f.token);
  const event = version => ({ serverId: '1', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/main.c', version,
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'diagnostic', severity: 1 }] } });
  f.events().onmessage(event(1));
  assert.equal(f.markers.get(f.model.uri.toString()).length, 1);
  f.model.setValue('changed');
  assert.equal(f.markers.get(f.model.uri.toString()).length, 0);
  f.events().onmessage(event(1));
  assert.equal(f.markers.get(f.model.uri.toString()).length, 0);
  await f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  f.events().onmessage(event(1));
  assert.equal(f.markers.get(f.model.uri.toString()).length, 0);
  f.events().onmessage(event(2));
  assert.equal(f.markers.get(f.model.uri.toString()).length, 1);
});

test('missing language servers fail once and retry only after an explicit reset', async t => {
  const f = await fixture(t, { invoke(command) { if (command === 'start_lsp') return Promise.reject(new Error('Missing executable')); } });
  if (!f) return;
  for (let i = 0; i < 3; i++) await f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  assert.equal(f.calls.filter(c => c.command === 'start_lsp').length, 1);
  f.client.clear();
  await f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  assert.equal(f.calls.filter(c => c.command === 'start_lsp').length, 2);
});

test('cross-file rename creates dirty editable buffers without writing files or stealing focus', async t => {
  const edit = { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }, newText: 'renamed' };
  const f = await fixture(t, { invoke(command) { if (command === 'lsp_request') return { changes: { 'file:///workspace/main.c': [edit], 'file:///workspace/header.h': [edit] } }; } });
  if (!f) return;
  const result = await f.providers['c:Rename'].provideRenameEdits(f.model, { lineNumber: 1, column: 5 }, 'renamed', f.token);
  assert.equal(result.edits.length, 2);
  for (const change of result.edits) f.models.get(change.resource.toString()).setValue('int renamed;');
  assert.equal(f.state.active, 'main');
  assert.equal(f.state.tabs.length, 2);
  assert(f.state.tabs.every(tab => tab.text === 'int renamed;' && tab.original === 'int name;'));
  assert.equal(f.calls.filter(c => ['save_file', 'create_file', 'rename_file'].includes(c.command)).length, 0);
});

test('workspace reset ignores an old server startup response', async t => {
  let started;
  const f = await fixture(t, { invoke(command) { if (command === 'start_lsp') return new Promise(done => { started = done; }); } });
  if (!f) return;
  const pending = f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  await waitFor(() => started);
  f.state.root = '/other'; f.client.configure(f.settings, '/other');
  started({ serverId: 'old', capabilities: { hoverProvider: true } });
  assert.equal(await pending, undefined);
  assert.equal(f.calls.filter(c => c.command === 'lsp_request').length, 0);
});


test('switching C to C++ closes the old document before opening the new language', async t => {
  let resolveClose;
  const f = await fixture(t, { invoke(command) { if (command === 'close_lsp_document') return new Promise(done => { resolveClose = done; }); } });
  if (!f) return;
  await f.providers['c:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  f.state.tabs[0].language = 'cpp'; f.model.language = 'cpp';
  f.client.updateDocuments(f.state.tabs);
  await waitFor(() => resolveClose);
  assert.equal(f.calls.filter(c => c.command === 'sync_lsp_document').length, 1);
  resolveClose(null);
  await waitFor(() => f.calls.filter(c => c.command === 'sync_lsp_document').length === 2);
  await f.providers['cpp:Hover'].provideHover(f.model, { lineNumber: 1, column: 1 }, f.token);
  assert.equal(f.calls.filter(c => c.command === 'close_lsp_document').length, 1);
  assert.equal(f.calls.filter(c => c.command === 'start_lsp').length, 1);
});

test('completion snippets preserve server edits and untrusted documentation', async t => {
  const f = await fixture(t, { invoke(command) { if (command === 'lsp_request') return { isIncomplete: true, items: [{
    label: 'function', kind: 3, insertTextFormat: 2,
    textEdit: { replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'call($1)' },
    documentation: { kind: 'markdown', value: '[link](command:danger)' },
  }] }; } });
  if (!f) return;
  const result = await f.providers['c:CompletionItem'].provideCompletionItems(f.model, { lineNumber: 1, column: 3 }, { triggerKind: 0 }, f.token);
  assert.equal(result.incomplete, true);
  assert.equal(result.suggestions[0].insertText, 'call($1)');
  assert.equal(result.suggestions[0].range.endColumn, 4);
  assert.equal(result.suggestions[0].documentation.isTrusted, false);
});

test('JavaScript and TypeScript share one configured server and restore both built-in providers', async t => {
  const f = await fixture(t); if (!f) return;
  f.settings.servers.javascript = { enabled: true, executable: 'configured-ts-server', args: ['--stdio'], env: {} };
  const tsTab = { id: 'ts', path: 'main.ts', text: 'const answer: number = 42;', original: 'const answer: number = 42;', language: null };
  const jsTab = { id: 'js', path: 'main.js', text: 'const answer = 42;', original: 'const answer = 42;', language: null };
  f.state.tabs.push(tsTab, jsTab);
  const ts = f.createModel(tsTab.text, 'typescript', { scheme: 'editor', toString: () => 'editor://workspace/%252Fworkspace/ts.ts' });
  const js = f.createModel(jsTab.text, 'javascript', { scheme: 'editor', toString: () => 'editor://workspace/%252Fworkspace/js' });
  await f.providers['typescript:Hover'].provideHover(ts, { lineNumber: 1, column: 7 }, f.token);
  await f.providers['javascript:Hover'].provideHover(js, { lineNumber: 1, column: 7 }, f.token);
  assert.equal(f.calls.filter(c => c.command === 'start_lsp').length, 1);
  assert.equal(f.modes.javascript.hovers, false);
  assert.equal(f.modes.typescript.hovers, false);
  f.client.clear();
  assert.equal(f.modes.javascript.hovers, true);
  assert.equal(f.modes.typescript.hovers, true);
});

test('Rust, JSON and Perl providers synchronize the correct language and use configured peers', async t => {
  for (const [language, path] of [['rust', 'main.rs'], ['json', 'config.json'], ['perl', 'script.pl']]) {
    const f = await fixture(t); if (!f) return;
    f.settings.servers[language] = { enabled: true, executable: `server-${language}`, args: [], env: {} };
    const tab = { id: language, path, text: 'value', original: 'value', language: null };
    f.state.tabs.push(tab);
    const model = f.createModel(tab.text, language, { scheme: 'editor', toString: () => `editor://workspace/%252Fworkspace/${language}` });
    await f.providers[`${language}:Hover`].provideHover(model, { lineNumber: 1, column: 1 }, f.token);
    const sync = f.calls.find(c => c.command === 'sync_lsp_document');
    assert.equal(sync.args.language, language); assert.equal(sync.args.path, path);
    if (language === 'json') { assert.equal(f.modes.json.hovers, false); f.client.clear(); assert.equal(f.modes.json.hovers, true); }
  }
});

test('cross-file LSP edits retain the selected legacy file encoding', async t => {
  const edit = { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }, newText: 'renamed' };
  const f = await fixture(t, {
    read: async () => ({ text: 'int name; // 中文', encoding: 'big5' }),
    invoke(command) { if (command === 'lsp_request') return { changes: { 'file:///workspace/header.h': [edit] } }; },
  });
  if (!f) return;
  const result = await f.providers['c:Rename'].provideRenameEdits(f.model, { lineNumber: 1, column: 5 }, 'renamed', f.token);
  assert.equal(result.edits.length, 1);
  const inserted = f.state.tabs.find(tab => tab.path === 'header.h');
  assert.equal(inserted.encoding, 'big5');
  assert.equal(inserted.original, 'int name; // 中文');
  assert.equal(f.calls.filter(call => call.command === 'save_file').length, 0);
});
