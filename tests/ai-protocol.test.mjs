import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let api;
try { const ts = await import('typescript'); const js = ts.transpileModule(readFileSync(new URL('../src/ai-protocol.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText; api = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
test('AI settings normalize URLs and preserve chat-only preference without secrets', { skip: !api }, () => {
 const value = api.validateSettings({ ...api.defaultAiSettings, endpoint: 'https://example.com/v1/', model: ' model ', chatOnly: true, apiKey: 'must-not-be-serialized' });
 assert.deepEqual(value, { endpoint: 'https://example.com/v1', model: 'model', commandTimeoutSeconds: 120, chatOnly: true });
 for (const endpoint of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) assert.equal(api.validateSettings({ ...api.defaultAiSettings, endpoint, model: 'test' }).model, 'test');
});
test('AI endpoint validation prevents remote HTTP and embedded credentials', { skip: !api }, () => {
 for (const endpoint of ['file:///tmp', 'http://remote.example/v1', 'https://user:key@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#secret', 'https://exam\nple.com/v1']) assert.throws(() => api.validateSettings({ ...api.defaultAiSettings, endpoint, model: 'test' }));
});
test('AI model and timeout bounds reject malformed settings before IPC', { skip: !api }, () => {
 for (const model of ['', ' ', 'a'.repeat(257), 'test\nmodel']) assert.throws(() => api.validateSettings({ ...api.defaultAiSettings, model }));
 for (const commandTimeoutSeconds of [0, -1, 3601, 1.5, NaN]) assert.throws(() => api.validateSettings({ ...api.defaultAiSettings, model: 'test', commandTimeoutSeconds }));
});
