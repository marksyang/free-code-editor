import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { editorModelPath } from '../src/languages.ts';
import { jsonDiagnosticsOptions } from '../src/extra-languages.ts';

test('the bundled JSON worker validates JSON and rejects comments, trailing commas and malformed values', async t => {
  let source;
  try { source = readFileSync(new URL(import.meta.resolve('monaco-editor/esm/vs/language/json/json.worker.js')), 'utf8'); }
  catch (error) { if (['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) { t.skip('Monaco is not installed'); return; } throw error; }
  source = source.replace('import * as worker from "../../editor/editor.worker.js";', 'const worker = { initialize() {} };');
  source += '\nglobalThis.JsonWorkerForTest = JSONWorker;';
  const context = createContext({ self: {}, console, setTimeout, clearTimeout, URL });
  new Script(source, { filename: 'monaco-json.worker.js' }).runInContext(context, { timeout: 10000 });
  const uri = editorModelPath('/project', 'json', 'config.json', null);
  let text = '{"number":42,"text":"中文 🦀"}';
  const model = { uri: { toString: () => uri }, version: 1, getValue: () => text };
  const worker = new context.JsonWorkerForTest({ getMirrorModels: () => [model] }, {
    languageId: 'json', languageSettings: { ...jsonDiagnosticsOptions, schemas: [] }, enableSchemaRequest: false,
  });
  assert.equal((await worker.doValidation(uri)).length, 0);
  for (const invalid of ['{"number":1,}', '// comment\n{"number":1}', '{"number":}']) {
    text = invalid; model.version++;
    const diagnostics = await worker.doValidation(uri);
    assert(diagnostics.some(diagnostic => diagnostic.severity === 1), invalid);
  }
});
