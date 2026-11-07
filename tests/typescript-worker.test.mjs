import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { editorModelPath } from '../src/languages.ts';

test('standalone TypeScript worker validates types and parses TSX through real model URIs', async t => {
  let source, URI;
  try {
    source = readFileSync(new URL(import.meta.resolve('monaco-editor/esm/vs/language/typescript/ts.worker.js')), 'utf8');
    ({ URI } = await import('monaco-editor/esm/vs/base/common/uri.js'));
  }
  catch (error) { if (['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) { t.skip('Monaco is not installed'); return; } throw error; }
  // Run the actual browser worker in a context without Node's process/require globals.
  // The editor transport bootstrap is not used when calling its exported create() directly.
  source = source.replace('import { initialize } from "../../editor/editor.worker.js";', 'const initialize = () => {};');
  const start = source.lastIndexOf('\nexport {');
  const end = source.indexOf('\n};', start);
  assert(start >= 0 && end > start);
  source = source.slice(0, start) + source.slice(end + 3) + '\nglobalThis.createWorker = create;';
  const context = createContext({ self: {}, console, setTimeout, clearTimeout });
  new Script(source, { filename: 'monaco-typescript.worker.js' }).runInContext(context, { timeout: 10000 });
  const tsUri = URI.parse(editorModelPath('/project', 'ts', 'main.ts', null)).toString();
  const tsxUri = URI.parse(editorModelPath('/project', 'tsx', 'view.tsx', null)).toString();
  const models = [
    { uri: URI.parse(tsUri), version: 1, getValue: () => 'const answer: number = "wrong";' },
    { uri: URI.parse(tsxUri), version: 1, getValue: () => 'const element = <div id="example" />;' },
  ];
  const worker = context.createWorker({ getMirrorModels: () => models }, {
    compilerOptions: { allowNonTsExtensions: true, noLib: true, jsx: 1 }, extraLibs: {}, inlayHintsOptions: {},
  });
  assert.equal(worker.getScriptKind(tsUri), 3);
  assert.equal(worker.getScriptKind(tsxUri), 4);
  assert.equal((await worker.getSyntacticDiagnostics(tsxUri)).length, 0);
  const diagnostics = await worker.getSemanticDiagnostics(tsUri);
  assert(diagnostics.some(diagnostic => diagnostic.code === 2322));
});
