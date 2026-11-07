import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : 'google-chrome');
const temporary = mkdtempSync(join(tmpdir(), 'free-code-editor-ui-'));
const root = resolve('dist');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const markdown = ['# Preview', '', '| Name | Value |', '| --- | --- |', '| one | two |', '', '- [x] done', '', '<script>window.__xss = true</script>', '', '```js', 'const value = "<script>";', '```', ''].join('\n');
const setup = `
window.__smokeErrors = [];
window.addEventListener('error', e => window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection', e => window.__smokeErrors.push(String(e.reason)));
const buffers = {
  'README.md': ${JSON.stringify(markdown)},
  'Makefile': 'all:\\n\\t@echo test\\n',
};
window.__snapshots = [];
window.__searchCalls = [];
let callbackId = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
  transformCallback() { return ++callbackId; },
  invoke: async (command, args = {}) => {
    if (command === 'load_lsp_settings') return { enabled: false, servers: {} };
    if (command === 'load_session') return { version: 1, root: '/fixture', tabs: [
      { id: 'markdown', path: 'README.md', text: buffers['README.md'], original: 'older version', language: null }
    ], active: 'markdown', secondary: '', split: false, preview: true, english: false, sidebar: true, width: 1280, height: 850 };
    if (command === 'save_session') { window.__snapshots.push(args.payload); return; }
    if (command === 'open_workspace') return { root: '/fixture', files: Object.keys(buffers), directories: ['empty'], selected: null };
    if (command === 'list_directory') return { root: '/fixture', files: Object.keys(buffers).filter(path => path.slice(0, path.lastIndexOf('/') + 1) === (args.path ? args.path + '/' : '')), directories: [], selected: null };
    if (command === 'list_files') return Object.keys(buffers);
    if (command === 'list_workspace') return { root: '/fixture', files: Object.keys(buffers), directories: ['empty'], selected: null };
    if (command === 'read_file') { if (!(args.path in buffers)) throw 'Missing file'; return buffers[args.path]; }
    if (command === 'create_file') { if (args.path in buffers) throw 'Already exists'; buffers[args.path] = args.content; return; }
    if (command === 'save_file') { if (buffers[args.path] !== args.original) throw 'Conflict'; buffers[args.path] = args.content; return; }
    if (command === 'search_files') { window.__searchCalls.push(args); return args.directory === 'empty' ? [] : [{ path: 'Makefile', line: 2, column: 1, preview: '\\t@echo test' }]; }
    if (command === 'cancel_search') return;
    if (command === 'plugin:event|listen') return ++callbackId;
    if (command.startsWith('plugin:window|') || command === 'plugin:event|unlisten') return;
    throw new Error('Unexpected IPC command: ' + command);
  },
};
`;
const checks = `
(async () => {
  const checks = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(predicate, name) {
    for (let i = 0; i < 100; i++) { if (predicate()) { checks.push(name); return; } await delay(100); }
    throw new Error(name + ' timed out');
  }
  function assert(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
  function key(key, shiftKey = false) { window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true, cancelable: true })); }
  function button(text) { const node = [...document.querySelectorAll('button')].find(n => n.textContent === text); if (!node) throw new Error('Missing button ' + text); node.click(); }
  function input(node, value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }
  try {
    await waitFor(() => document.querySelector('.markdown-preview table') && document.querySelector('.monaco-editor'), 'recovered Markdown editor renders');
    assert(document.querySelector('.markdown-preview input[type=checkbox][disabled]'), 'GFM task list renders');
    assert(document.querySelector('.file-tree [role=tree]'), 'folder explorer uses a tree');
    assert(document.querySelector('.file-tree [data-path="empty"]')?.getAttribute('data-kind') === 'directory', 'empty folders remain folders');
    const workspaceRoot = document.querySelector('.file-tree [data-path=""]');
    assert(workspaceRoot?.getAttribute('aria-label') === 'fixture', 'workspace folder appears as the root');
    workspaceRoot.querySelector('.tree-row').click();
    await delay(100);
    assert(!document.querySelector('.file-tree [data-path="Makefile"]'), 'collapsing root hides files');
    document.querySelector('.file-tree [data-path=""] > .tree-row').click();
    await waitFor(() => document.querySelector('.file-tree [data-path="Makefile"]'), 'expanding root reveals files');
    assert(!window.__xss && !document.querySelector('.markdown-preview script'), 'Markdown raw HTML cannot execute');
    document.querySelector('.file-tree [data-path="empty"] > .tree-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 150 }));
    await waitFor(() => document.querySelector('[role=menuitem]'), 'folder context menu opens');
    document.querySelector('[role=menuitem]').click();
    await waitFor(() => document.querySelector('.search-scope')?.textContent.includes('empty'), 'folder search scope is visible');
    input(document.querySelector('.explorer-search > input'), 'test');
    await waitFor(() => window.__searchCalls.some(call => call.directory === 'empty'), 'folder search sends the selected relative directory');
    document.querySelector('.search-scope button').click();
    await waitFor(() => window.__searchCalls.some(call => call.directory === ''), 'search can return to the entire workspace');
    document.querySelector('.sidebar-tabs button').click();
    await waitFor(() => document.querySelector('.file-tree'), 'files view can be restored');
    key('p');
    await waitFor(() => document.querySelector('.palette'), 'quick open shortcut opens palette');
    input(document.querySelector('.palette > input'), 'mkfl');
    await delay(200);
    assert(document.querySelector('.palette-list button')?.textContent.includes('Makefile'), 'fuzzy matching finds Makefile');
    document.querySelector('.palette-list button').click();
    await waitFor(() => [...document.querySelectorAll('.tab')].some(n => n.textContent.includes('Makefile')), 'quick open opens file');
    document.querySelector('.tab button[title="README.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 80 }));
    await waitFor(() => document.querySelector('.tab-context-menu'), 'tab context menu opens');
    document.querySelectorAll('.tab-context-menu button')[1].click();
    await waitFor(() => document.querySelector('.compare-editor .monaco-diff-editor'), 'active tab comparison renders a real Monaco diff editor');
    assert(document.querySelector('.compare-labels').textContent.includes('README.md') && document.querySelector('.compare-labels').textContent.includes('Makefile'), 'comparison labels both buffers');
    const beforeSwap = document.querySelector('.compare-labels span').textContent;
    document.querySelector('.compare-toolbar button').click();
    await waitFor(() => document.querySelector('.compare-labels span').textContent !== beforeSwap, 'comparison sides can be swapped');
    document.querySelector('.compare-toolbar button:last-child').click();
    await waitFor(() => !document.querySelector('.compare-panel') && document.querySelectorAll('.tab').length === 2, 'closing comparison preserves both original tabs');
    key('\\\\');
    await waitFor(() => document.querySelectorAll('.editor-pane').length === 2, 'split editor opens');
    key('n');
    await waitFor(() => [...document.querySelectorAll('.tab')].some(n => n.textContent.includes('未命名')), 'new buffer opens');
    key('s');
    await waitFor(() => document.querySelector('.dialog input'), 'saving new buffer prompts for path');
    input(document.querySelector('.dialog input'), 'new.md');
    document.querySelector('.dialog').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => [...document.querySelectorAll('.tab')].some(n => n.textContent.includes('new.md')), 'new file saves');
    assert(!document.querySelector('.tab.active')?.textContent.includes('●'), 'saved buffer is clean');
    key('p', true);
    await waitFor(() => document.querySelector('.palette'), 'command palette opens');
    input(document.querySelector('.palette > input'), 'language');
    await delay(200);
    document.querySelector('.palette-list button').click();
    await waitFor(() => [...document.querySelectorAll('header button')].some(n => n.textContent === 'Save'), 'interface switches to English');
    await delay(900);
    assert(window.__snapshots.some(s => s.tabs.some(t => t.path === 'new.md')), 'session checkpoint contains saved file');
    assert(window.__smokeErrors.length === 0, 'no uncaught browser errors: ' + JSON.stringify(window.__smokeErrors));
    const report = document.createElement('pre'); report.id = 'smoke-result'; report.textContent = JSON.stringify({ ok: true, checks }); document.body.append(report);
  } catch (error) {
    const report = document.createElement('pre'); report.id = 'smoke-result'; report.textContent = JSON.stringify({ ok: false, error: String(error), checks, browserErrors: window.__smokeErrors }); document.body.append(report);
  }
})();
`;
new Script(setup);
new Script(checks);
const harness = html.replaceAll('"/assets/', `"${pathToFileURL(root).href}/assets/`)
  .replace('<div id="root">', `<script>${setup.replaceAll("</script>", "<\\/script>")}</script><div id="root">`) + `<script>${checks}</script>`;
try {
  const page = join(temporary, 'index.html');
  writeFileSync(page, harness);
  const result = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--disable-crash-reporter', '--allow-file-access-from-files', `--user-data-dir=${join(temporary, 'profile')}`,
    '--virtual-time-budget=18000', '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const match = result.stdout?.match(/<pre id="smoke-result">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.error('UI smoke test did not complete.', { status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr?.slice(-1800) });
    process.exitCode = 1;
  } else {
    const decoded = match[1].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const report = JSON.parse(decoded);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
