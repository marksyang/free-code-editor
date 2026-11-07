import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ancestorDirectories, buildWorkspaceTree, filterWorkspaceTree, visibleTreeRows, workspaceName } from '../src/file-tree-model.ts';

const paths = rows => rows.map(row => row.node.path);
const files = ['README.md', 'src/main.tsx', 'src/components/Button.tsx', 'assets/icon.png', 'notes10.md', 'notes2.md'];
const directories = ['assets', 'empty', 'src', 'src/components'];

test('workspace tree has a named root, folders before files, and explicit empty directories', () => {
  const tree = buildWorkspaceTree('/Users/me/Projects', files, directories);
  assert.equal(tree.name, 'Projects');
  assert.deepEqual(tree.children.map(node => node.name), ['assets', 'empty', 'src', 'notes2.md', 'notes10.md', 'README.md']);
  assert.deepEqual(tree.children.find(node => node.name === 'empty'), { name: 'empty', path: 'empty', kind: 'directory', children: [] });
  assert.equal(tree.children.find(node => node.name === 'src').children[0].path, 'src/components');
});

test('collapsed directories hide descendants and expanding a branch preserves relative file paths', () => {
  const tree = buildWorkspaceTree('/project', files, directories);
  const rootOnly = visibleTreeRows(tree, path => path === '');
  assert(paths(rootOnly).includes('src'));
  assert(!paths(rootOnly).includes('src/main.tsx'));
  const expanded = visibleTreeRows(tree, path => ['', 'src'].includes(path));
  assert(paths(expanded).includes('src/main.tsx'));
  assert(!paths(expanded).includes('src/components/Button.tsx'));
  assert.equal(expanded.find(row => row.node.path === 'src/main.tsx').depth, 2);
  assert.deepEqual(paths(visibleTreeRows(tree, () => false)), ['']);
});

test('filtering preserves parent folders and matches empty folders or a whole directory subtree', () => {
  const tree = buildWorkspaceTree('/project', files, directories);
  const filtered = filterWorkspaceTree(tree, 'BUTTON');
  assert.deepEqual(paths(visibleTreeRows(filtered, () => true)), ['', 'src', 'src/components', 'src/components/Button.tsx']);
  assert.deepEqual(filterWorkspaceTree(tree, 'empty').children.map(node => node.path), ['empty']);
  assert.deepEqual(filterWorkspaceTree(tree, 'src').children, [tree.children.find(node => node.path === 'src')]);
  assert.equal(filterWorkspaceTree(tree, 'no-result').children.length, 0);
  assert.equal(tree.children.length, 6);
});

test('active-file ancestors can be revealed and root names handle trailing separators', () => {
  assert.deepEqual(ancestorDirectories('src/components/Button.tsx'), ['', 'src', 'src/components']);
  assert.deepEqual(ancestorDirectories('README.md'), ['']);
  assert.equal(workspaceName('/Users/me/Projects/'), 'Projects');
  assert.equal(workspaceName('/'), '/');
  assert.equal(workspaceName('C:\\Users\\me\\Projects\\'), 'Projects');
});

test('repeated paths remain unique and extensionless files are never inferred to be folders', () => {
  const tree = buildWorkspaceTree('/project', ['Makefile', 'Makefile', 'src/main.c', '../outside', '/absolute'], ['src', 'src']);
  const rows = visibleTreeRows(tree, () => true);
  assert.deepEqual(paths(rows), ['', 'src', 'src/main.c', 'Makefile']);
  assert.equal(tree.children.find(node => node.name === 'Makefile').kind, 'file');
});

test('React tree rendering exposes directory semantics and marks the active file', async t => {
  let ts, React, renderToStaticMarkup;
  try { ts = await import('typescript'); React = await import('react'); ({ renderToStaticMarkup } = await import('react-dom/server')); }
  catch { t.skip('React and TypeScript are not installed'); return; }
  const source = readFileSync(new URL('../src/FileTree.tsx', import.meta.url), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  js = js.replaceAll("'react'", JSON.stringify(import.meta.resolve('react')))
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replaceAll("'./file-tree-model'", JSON.stringify(new URL('../src/file-tree-model.ts', import.meta.url).href));
  const { FileTree } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const html = renderToStaticMarkup(React.createElement(FileTree, {
    root: '/Users/me/Projects', files: ['README.md', 'src/main.c'], directories: ['empty', 'src'], activePath: 'README.md', filter: '', english: true, open() {}, disabled: false,
  }));
  assert.match(html, /role="tree"/);
  assert.match(html, /aria-label="Projects"/);
  assert.match(html, /aria-expanded="true"[^>]*data-path=""/);
  assert.match(html, /aria-label="empty"[^>]*aria-expanded="false"[^>]*data-kind="directory"/);
  assert.match(html, /aria-label="README.md"[^>]*aria-selected="true"/);
  assert(!html.includes('aria-label="main.c"'));
});
