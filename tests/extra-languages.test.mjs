import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { puppetLanguage, bitbakeLanguage } from '../src/extra-languages.ts';

let compile, MonarchTokenizer, TokenizationRegistry;
try {
  ({ compile } = await import('monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js'));
  ({ MonarchTokenizer } = await import('monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js'));
  ({ TokenizationRegistry } = await import('monaco-editor/esm/vs/editor/common/languages.js'));
} catch { /* Optional when Monaco dependencies have not been installed. */ }
const languageService = {
  getLanguageIdByLanguageName: id => id, getLanguageIdByMimeType: () => null,
  isRegisteredLanguageId: () => true, requestBasicLanguageFeatures() {}, languageIdCodec: { encodeLanguageId: () => 1 },
};
async function basicLanguage(id) {
  const location = import.meta.resolve(`monaco-editor/esm/vs/basic-languages/${id}/${id}.js`);
  let source = readFileSync(new URL(location), 'utf8');
  if (source.includes('import * as monaco_editor_core_star from "../../editor/editor.api.js";')) {
    // Only the editor's indentation enums are needed; avoid importing its CSS/DOM entrypoint in Node.
    source = source.replace('import * as monaco_editor_core_star from "../../editor/editor.api.js";', '');
    source = `import * as enums from ${JSON.stringify(import.meta.resolve('monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js'))};\nconst monaco_editor_core_star = { languages: enums };\n` + source;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return import(location);
}
function tokenizer(id, grammar) {
  return new MonarchTokenizer(languageService, {}, id, compile(id, grammar), {
    getValue: () => 100000, onDidChangeConfiguration: () => ({ dispose() {} }),
  });
}
function harness(t, id, grammar) {
  if (!compile) { t.skip('Monaco is not installed'); return null; }
  const instance = tokenizer(id, grammar); t.after(() => instance.dispose());
  let state = instance.getInitialState();
  return line => { const result = instance.tokenize(line, true, state); state = result.endState; return result.tokens; };
}
function typeAt(tokens, offset) { return tokens.filter(t => t.offset <= offset).at(-1)?.type; }

test('Puppet resources distinguish comments, variables, strings and resource operators', t => {
  const line = harness(t, 'puppet', puppetLanguage); if (!line) return;
  assert.match(typeAt(line('class example {'), 0), /^keyword/);
  const assignment = '$message = "Hello ${facts[\'os\']} # literal" # comment';
  const tokens = line(assignment);
  assert.match(typeAt(tokens, 1), /^variable/);
  assert.match(typeAt(tokens, assignment.indexOf('${')), /^variable/);
  assert.match(typeAt(tokens, assignment.indexOf('# literal')), /^string/);
  assert.match(typeAt(tokens, assignment.indexOf('# comment')), /^comment/);
  const resource = 'file { "/tmp/example": ensure => present, mode => "0644" }';
  assert.match(typeAt(line(resource), resource.indexOf('=>')), /^operator/);
});

test('Puppet multiline comments return to normal tokenization after closing', t => {
  const line = harness(t, 'puppet', puppetLanguage); if (!line) return;
  assert.match(typeAt(line('/* start'), 0), /^comment/);
  assert.match(typeAt(line('still a comment'), 0), /^comment/);
  const text = '*/ class example {}';
  assert.match(typeAt(line(text), text.indexOf('class')), /^keyword/);
});

test('BitBake assignment operators, overrides, interpolation and continued strings retain their modes', t => {
  const line = harness(t, 'bitbake', bitbakeLanguage); if (!line) return;
  for (const operator of ['=', '?=', '??=', ':=', '+=', '=+', '.=', '=.']) {
    const text = `PACKAGECONFIG:append:pn-demo ${operator} " value ${'${PN}'}"`;
    const tokens = line(text);
    assert.match(typeAt(tokens, text.indexOf(operator)), /^operator/, operator);
    assert.match(typeAt(tokens, text.indexOf('${')), /^variable/);
  }
  const first = 'SRC_URI = "file://one \\';
  assert.match(typeAt(line(first), first.indexOf('file://')), /^string/);
  assert.match(typeAt(line('  file://two" # outside'), 3), /^string/);
  assert.match(typeAt(line('# a comment'), 0), /^comment/);
  assert.match(typeAt(line('inherit cmake'), 0), /^keyword/);
});

test('BitBake embeds actual Python and Shell tokenizers and exits at the recipe function boundary', async t => {
  if (!compile) { t.skip('Monaco is not installed'); return; }
  for (const id of ['python', 'shell']) {
    const { language } = await basicLanguage(id);
    const instance = tokenizer(id, language), registration = TokenizationRegistry.register(id, instance);
    t.after(() => { registration.dispose(); instance.dispose(); });
  }
  const line = harness(t, 'bitbake', bitbakeLanguage);
  line('python do_configure() {');
  const python = line('    value = {"key": 1}');
  assert(python.some(token => token.language === 'python' && /^string/.test(token.type)));
  assert(line('}').every(token => token.language === 'bitbake'));
  line('do_install:append() {');
  assert(line('    echo "${D}"').some(token => token.language === 'shell'));
  line('}');
  assert.match(typeAt(line('require base.inc'), 0), /^keyword/);
});

test('installed Rust, TypeScript and Perl tokenizers recognize representative source', async t => {
  if (!compile) { t.skip('Monaco is not installed'); return; }
  for (const [id, source, offset, expected] of [
    ['rust', 'fn main() { let value = "hello"; }', 0, /^keyword/],
    ['typescript', 'const value: number = 42;', 13, /^keyword/],
    ['perl', 'my $value = "hello";', 3, /^variable/],
  ]) {
    const { language } = await basicLanguage(id);
    const line = harness(t, id, language);
    assert.match(typeAt(line(source), offset), expected, id);
  }
});
