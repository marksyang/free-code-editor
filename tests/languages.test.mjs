import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageForPath } from '../src/languages.ts';

test('recognizes extensionless Makefiles in nested directories', () => {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    assert.equal(languageForPath(`project/build/${name}`), 'makefile');
  }
  assert.equal(languageForPath('config/rules.mk'), 'makefile');
  assert.equal(languageForPath('docs/Makefile.md'), 'markdown');
});

test('recognizes language variants without treating extensionless files as code', () => {
  assert.equal(languageForPath('src/main.cxx'), 'cpp');
  assert.equal(languageForPath('README.MD'), 'markdown');
  assert.equal(languageForPath('scripts/setup.bash'), 'shell');
  assert.equal(languageForPath('js'), 'plaintext');
  assert.equal(languageForPath('unknown.xyz'), 'plaintext');
});

test('recognizes Rust, JSON, TypeScript and Perl extensions case-insensitively', () => {
  for (const [path, expected] of [
    ['src/main.rs', 'rust'], ['CONFIG.JSON', 'json'], ['src/main.ts', 'typescript'],
    ['src/view.tsx', 'typescript'], ['types/api.d.ts', 'typescript'], ['src/import.mts', 'typescript'], ['src/module.cts', 'typescript'],
    ['scripts/tool.pl', 'perl'], ['lib/Example.pm', 'perl'], ['t/basic.t', 'perl'], ['app.psgi', 'perl'],
  ]) assert.equal(languageForPath(path), expected, path);
});

test('recognizes Puppet and BitBake while keeping ambiguous include/configuration files neutral', () => {
  for (const path of ['site.pp', 'manifests/site.PP']) assert.equal(languageForPath(path), 'puppet');
  for (const path of ['recipe.bb', 'recipe_%.bbappend', 'classes/common.bbclass', 'meta-demo/recipes-core/base/base.inc',
    'meta-demo/conf/layer.conf', 'build/conf/local.conf', 'build/conf/bblayers.conf', 'meta-demo/conf/machine/board.conf']) {
    assert.equal(languageForPath(path), 'bitbake', path);
  }
  assert.equal(languageForPath('src/file.inc'), 'plaintext');
  assert.equal(languageForPath('nginx/nginx.conf'), 'plaintext');
  assert.equal(languageForPath('source.pas'), 'pascal');
});

test('manual modes and Markdown fences include all newly supported languages', async () => {
  const { languageIds, languageForCodeFence } = await import('../src/languages.ts');
  for (const id of ['rust', 'json', 'typescript', 'perl', 'puppet', 'pascal', 'bitbake']) assert(languageIds.includes(id));
  assert.equal(languageForCodeFence('rs'), 'rust');
  assert.equal(languageForCodeFence('ts'), 'typescript');
  assert.equal(languageForCodeFence('pl'), 'perl');
  assert.equal(languageForCodeFence('bb'), 'bitbake');
  assert.equal(languageForCodeFence('pp'), 'puppet');
  assert.equal(languageForCodeFence('unknown'), 'plaintext');
});

test('TypeScript model URIs preserve TSX and declaration parsing without changing other modes', async () => {
  const { editorModelPath } = await import('../src/languages.ts');
  assert(editorModelPath('/project', 'a', 'view.tsx', null).endsWith('/a.tsx'));
  assert(editorModelPath('/project', 'a', 'api.d.ts', null).endsWith('/a.d.ts'));
  assert(editorModelPath('/project', 'a', 'source.mts', null).endsWith('/a.ts'));
  assert(editorModelPath('/project', 'a', 'source.txt', 'typescript').endsWith('/a.ts'));
  assert(editorModelPath('/project', 'a', 'source.tsx', 'plaintext').endsWith('/a'));
});
