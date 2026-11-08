import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { monaco } from './monaco';
import { languageForPath, languageIds, editorModelPath } from './languages';
import { editorReducer, initialSession, normalizeSession, isDirty, fuzzyPaths, closeSnapshot, recoverTab } from './editor-state';
import type { Action, Session, Tab } from './editor-state';
import { comparisonForPath } from './compare-files';
import { AiPanel } from './AiPanel';
import { GitPanel } from './GitPanel';
import { TerminalPanel } from './TerminalPanel';
import { CompareView } from './CompareView';
import { CodePane } from './CodePane';
import { MarkdownPreview } from './MarkdownPreview';
import { ExplorerIcon, FileTree } from './FileTree';
import { LspBridge } from './lsp-bridge';
import { LspSettings } from './LspSettings';
import { serverKey } from './lsp-protocol';
import type { LspSettings as LspSettingsData } from './lsp-protocol';
import { Dialog, Palette } from './Overlays';
import type { DialogSpec, DialogResult, PaletteEntry } from './Overlays';
import { encodingChoices } from './text-encoding';
import type { TextEncoding, TextDocument } from './text-encoding';
import { absoluteFileLocation, normalizeUserPath, shortcutLabel } from './platform';
import './style.css';
const isWindows = navigator.platform.startsWith('Win');
const shortcut = (value: string) => shortcutLabel(value, /Mac/i.test(navigator.platform));

loader.config({ monaco });
const loadTreeDirectory = (path: string) => invoke<WorkspaceInfo>('list_directory', { path });
type WorkspaceInfo = { root: string; files: string[]; directories: string[]; selected: string | null };
type SearchMatch = { path: string; line: number; column: number; preview: string };
type Pane = 'primary' | 'secondary';
const newId = () => crypto.randomUUID();

function App() {
  const [state, dispatch] = useReducer(editorReducer, initialSession);
  const [indexedFiles, setIndexedFiles] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [rootInput, setRootInput] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [ready, setReady] = useState(false);
  const [pane, setPane] = useState<Pane>('primary');
  const [palette, setPalette] = useState<'files' | 'commands' | 'compare' | null>(null);
  const [compareSource, setCompareSource] = useState('');
  const [comparison, setComparison] = useState<{ left: Tab; right: Tab } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [search, setSearch] = useState(false);
  const [searchDirectory, setSearchDirectory] = useState('');
  const [searchEncoding, setSearchEncoding] = useState<TextEncoding>('utf8');
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [pathFilter, setPathFilter] = useState('');
  const [lspSettings, setLspSettings] = useState<LspSettingsData | null>(null);
  const [lspSettingsOpen, setLspSettingsOpen] = useState(false);
  const [lspStatus, setLspStatus] = useState<Record<string, string>>({});
  const bridge = useRef<LspBridge | null>(null);
  const focusedPane = useRef(pane);
  focusedPane.current = pane;
  const current = useRef(state);
  current.current = state;
  const busy = useRef(false);
  const aiBusy = useRef(false);
  const closing = useRef(false);
  const recoveryEnabled = useRef(true);
  const dialogDone = useRef<((result: DialogResult) => void) | null>(null);
  const editorRefs = useRef<Record<Pane, monaco.editor.IStandaloneCodeEditor | null>>({ primary: null, secondary: null });
  const jump = useRef<{ path: string; line: number; column: number; pane: Pane } | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const label = (zh: string, en: string) => state.english ? en : zh;
  const activeId = pane === 'secondary' && state.split ? state.secondary : state.active;
  const activeTab = state.tabs.find(t => t.id === activeId);
  const primary = state.tabs.find(t => t.id === state.active);
  const secondary = state.tabs.find(t => t.id === state.secondary);
  const serviceKey = activeTab ? serverKey(activeTab.language ?? languageForPath(activeTab.path)) : null;
  const serviceStatus = !lspSettings?.enabled ? label('已停用', 'Disabled')
    : serviceKey ? lspStatus[serviceKey] ?? label('尚未啟動', 'Not started') : label('基本編輯', 'Basic editing');

  useEffect(() => {
    if (!tabMenu) return;
    tabMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => { if (!tabMenuRef.current?.contains(event.target as Node)) setTabMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); setTabMenu(null); } };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape, true); };
  }, [tabMenu]);

  async function compareWithPath(path: string) {
    const left = current.current.tabs.find(tab => tab.id === compareSource);
    if (!left) return;
    try {
      const workspace = current.current.root;
      const result = await comparisonForPath(left, path, current.current.tabs, async path => (await readDocument(path)).text);
      if (current.current.root === workspace && current.current.tabs.some(tab => tab.id === left.id)) setComparison(result);
    } catch (error) { setError(String(error)); }
  }

  function send(action: Action) {
    current.current = editorReducer(current.current, action);
    dispatch(action);
  }
  function ask(spec: DialogSpec): Promise<DialogResult> {
    dialogDone.current?.({ choice: 'cancel', value: '' });
    setDialog(spec);
    return new Promise(resolve => { dialogDone.current = resolve; });
  }
  function finishDialog(result: DialogResult) {
    const resolve = dialogDone.current;
    dialogDone.current = null;
    setDialog(null);
    resolve?.(result);
  }
  async function run<T,>(operation: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try { setError(''); return await operation(); }
    catch (e) { if (String(e) !== 'Error: READ_CANCELLED') setError(String(e)); return undefined; }
    finally { busy.current = false; setWorking(false); }
  }
  async function readDocument(path: string, encoding?: TextEncoding): Promise<TextDocument> {
    try { return await invoke<TextDocument>('read_document', { path, encoding: encoding ?? 'utf8' }); }
    catch (error) {
      if (encoding || !String(error).includes('ENCODING_REQUIRED')) throw error;
      const en = current.current.english;
      const choice = await ask({ title: en ? 'Choose file encoding' : '選擇檔案編碼', message: `${path}\n${en ? 'This file is not valid UTF-8. Choose its original encoding.' : '這個檔案不是有效的 UTF-8，請選擇原始編碼。'}`,
        choices: [...encodingChoices.filter(item => item.id !== 'utf8'), { id: 'cancel', label: en ? 'Cancel' : '取消' }] });
      if (choice.choice === 'cancel') throw new Error('READ_CANCELLED');
      return invoke<TextDocument>('read_document', { path, encoding: choice.choice });
    }
  }
  async function reopenEncoding(encoding: TextEncoding) {
    const tab = activeTab;
    if (!tab || busy.current) return;
    if (!tab.path || tab.original === null) { send({ type: 'encoding', id: tab.id, encoding }); return; }
    if (!await confirmTabs([tab])) return;
    await run(async () => { const doc = await readDocument(tab.path, encoding); send({ type: 'reload', id: tab.id, ...doc }); });
  }
  function checkpoint(snapshot: Session) {
    const write = writes.current.catch(() => {}).then(() => invoke('save_session', { payload: snapshot }));
    writes.current = write;
    return write;
  }
  async function refresh() {
    const info = await invoke<WorkspaceInfo>('list_workspace');
    setFiles(info.files); setDirectories(info.directories ?? []);
  }
  function focusTab(id: string, target: Pane = pane) {
    send({ type: 'focus', id, pane: target });
    setPane(target);
  }
  async function openFile(path: string, target: Pane = pane, position?: { line: number; column: number }, encoding?: TextEncoding) {
    if (busy.current) return;
    if (position) jump.current = { path, ...position, pane: target };
    const existing = current.current.tabs.find(t => t.path === path);
    if (existing) { focusTab(existing.id, target); requestAnimationFrame(applyJump); return; }
    if (current.current.tabs.length >= 100) { setError(label('最多可開啟 100 個分頁。', 'A maximum of 100 tabs can be opened.')); return; }
    await run(async () => {
      const doc = await readDocument(path, encoding);
      send({ type: 'open', tab: { id: newId(), path, ...doc, original: doc.text, language: null }, pane: target });
      setPane(target);
    });
  }
  async function saveTab(id: string, saveAs = false): Promise<boolean> {
    const snapshot = current.current.tabs.find(t => t.id === id);
    if (!snapshot || busy.current) return false;
    let path = snapshot.path;
    let encoding = snapshot.encoding ?? 'utf8';
    if (saveAs || !path) {
      const result = await ask({ title: label(saveAs ? '另存新檔' : '儲存檔案', saveAs ? 'Save As' : 'Save file'),
        message: current.current.root ? label('輸入相對於專案的路徑；父資料夾須已存在。不覆寫既有檔案。', 'Enter a workspace-relative path. Parent folders must exist. Existing files are not overwritten.') : label('輸入完整檔案路徑，父資料夾將成為工作區。不覆寫既有檔案。', 'Enter an absolute file path. Its parent folder becomes the workspace. Existing files are not overwritten.'),
        input: path, placeholder: 'src/new-file.md', choices: [{ id: 'save', label: label('儲存', 'Save') }, { id: 'cancel', label: label('取消', 'Cancel') }] });
      if (result.choice !== 'save' || !result.value.trim()) return false;
      path = normalizeUserPath(result.value.trim(), isWindows);
      if (saveAs && path === snapshot.path) return saveTab(id);
    }
    if (saveAs) {
      const choice = await ask({ title: label('另存新檔的編碼', 'Save As encoding'), choices: [...encodingChoices, { id: 'cancel', label: label('取消', 'Cancel') }] });
      if (choice.choice === 'cancel') return false;
      encoding = choice.choice as TextEncoding;
    }
    const establishingWorkspace = !current.current.root;
    const location = establishingWorkspace ? absoluteFileLocation(path, isWindows) : null;
    if (establishingWorkspace && !location) {
      setError(label('請輸入完整的檔案路徑。', 'Enter an absolute file path.')); return false;
    }
    const output = await run(async () => {
      if (establishingWorkspace) {
        const directory = location!.directory;
        const info = await invoke<WorkspaceInfo>('open_workspace', { path: directory });
        path = location!.name;
        send({ type: 'restore', session: { ...current.current, root: info.root } });
        setRootInput(info.root); setFiles(info.files); setDirectories(info.directories ?? []); recoveryEnabled.current = true;
      }
      if (saveAs || snapshot.original === null) await invoke('create_file', { path, content: snapshot.text, encoding });
      else await invoke('save_file', { path, original: snapshot.original, content: snapshot.text, encoding });
      send({ type: 'saved', id, text: snapshot.text, path, encoding });
      void bridge.current?.saved(id, snapshot.text);
      setFiles(previous => [...new Set([...previous, path])].sort());
      return true;
    });
    return output === true;
  }
  async function confirmTabs(tabs: Tab[], discarded?: Set<string>): Promise<boolean> {
    for (const tab of tabs.filter(isDirty)) {
      const result = await ask({ title: label('尚有未儲存的變更', 'Unsaved changes'),
        message: tab.path || label('未命名檔案', 'Untitled'), choices: [
          { id: 'save', label: label('儲存', 'Save') }, { id: 'discard', label: label('捨棄', 'Discard') }, { id: 'cancel', label: label('取消', 'Cancel') },
        ] });
      if (result.choice === 'cancel') return false;
      if (result.choice === 'discard') discarded?.add(tab.id);
      if (result.choice === 'save' && !await saveTab(tab.id)) return false;
    }
    return true;
  }
  async function closeTab(id: string) {
    if (busy.current) return;
    const tab = current.current.tabs.find(t => t.id === id);
    if (tab && await confirmTabs([tab])) send({ type: 'close', id });
  }
  async function openWorkspace(path = rootInput) {
    if (busy.current || !path.trim() || !await confirmTabs(current.current.tabs)) return;
    await run(async () => {
      const info = await invoke<WorkspaceInfo>('open_workspace', { path: path.trim() });
      send({ type: 'workspace', root: info.root });
      setFiles(info.files); setDirectories(info.directories ?? []); setRootInput(info.root); setPane('primary');
      setSearchDirectory(''); setSearchQuery(''); setResults([]); setPathFilter('');
      recoveryEnabled.current = true;
      if (info.selected) {
        const doc = await readDocument(info.selected);
        send({ type: 'open', tab: { id: newId(), path: info.selected, ...doc, original: doc.text, language: null } });
      }
    });
  }
  function newFile() {
    if (busy.current || !ready) return;
    if (current.current.tabs.length >= 100) { setError(label('最多可開啟 100 個分頁。', 'A maximum of 100 tabs can be opened.')); return; }
    send({ type: 'open', tab: { id: newId(), path: '', text: '', original: null, language: null }, pane });
  }
  async function renameTab() {
    if (!activeTab?.path || activeTab.original === null || busy.current) return;
    const snapshot = { ...activeTab };
    const result = await ask({ title: label('重新命名檔案', 'Rename file'), input: snapshot.path,
      choices: [{ id: 'rename', label: label('重新命名', 'Rename') }, { id: 'cancel', label: label('取消', 'Cancel') }] });
    if (result.choice !== 'rename' || result.value === snapshot.path || !result.value.trim()) return;
    await run(async () => {
      await invoke('rename_file', { path: snapshot.path, destination: normalizeUserPath(result.value.trim(), isWindows), original: snapshot.original, encoding: snapshot.encoding ?? 'utf8' });
      send({ type: 'renamed', id: snapshot.id, path: normalizeUserPath(result.value.trim(), isWindows) });
      await refresh();
    });
  }
  async function reloadTab() {
    if (!activeTab?.path || busy.current || !await confirmTabs([activeTab])) return;
    const tab = activeTab;
    await run(async () => {
      const doc = await readDocument(tab.path, tab.encoding);
      send({ type: 'reload', id: tab.id, ...doc });
    });
  }
  function showPalette(mode: 'files' | 'commands') { setTabMenu(null); setPaletteQuery(''); setPalette(mode); }
  async function promptWorkspace() {
    const result = await ask({ title: label('開啟檔案或專案', 'Open file or workspace'), input: rootInput,
      message: label('輸入檔案或資料夾的絕對路徑。', 'Enter the absolute path to a file or directory.'),
      choices: [{ id: 'open', label: label('開啟', 'Open') }, { id: 'cancel', label: label('取消', 'Cancel') }] });
    if (result.choice === 'open') await openWorkspace(result.value);
  }
  async function showLspSettings() {
    try {
      if (!lspSettings) setLspSettings(await invoke<LspSettingsData>('load_lsp_settings'));
      setLspSettingsOpen(true);
    } catch (error) { setError(String(error)); }
  }
  async function restartServices() {
    await run(async () => {
      await invoke('restart_lsp'); bridge.current?.clear(); bridge.current?.updateDocuments(current.current.tabs);
    });
  }
  const commands: PaletteEntry[] = [
    { id: 'lsp-settings', title: label('設定語言智慧功能（LSP）', 'Language service settings (LSP)'), run: () => { void showLspSettings(); } },
    { id: 'lsp-restart', title: label('重新啟動語言服務', 'Restart language services'), run: () => { void restartServices(); } },
    { id: 'definition', title: label('前往定義', 'Go to Definition'), detail: 'F12', run: () => { void editorRefs.current[focusedPane.current]?.getAction('editor.action.revealDefinition')?.run(); } },
    { id: 'references', title: label('尋找參照', 'Find References'), detail: '⇧F12', run: () => { void editorRefs.current[focusedPane.current]?.getAction('editor.action.referenceSearch.trigger')?.run(); } },
    { id: 'rename-symbol', title: label('重新命名符號', 'Rename Symbol'), detail: 'F2', run: () => { void editorRefs.current[focusedPane.current]?.getAction('editor.action.rename')?.run(); } },
    { id: 'open', title: label('開啟檔案或專案', 'Open file or workspace'), detail: shortcut('⌘O'), run: () => { void promptWorkspace(); } },
    { id: 'new', title: label('新增檔案', 'New file'), detail: shortcut('⌘N'), run: newFile },
    { id: 'save', title: label('儲存檔案', 'Save file'), detail: shortcut('⌘S'), run: () => { if (activeTab) void saveTab(activeTab.id); } },
    { id: 'save-as', title: label('另存新檔', 'Save As'), detail: shortcut('⌘⇧S'), run: () => { if (activeTab) void saveTab(activeTab.id, true); } },
    { id: 'rename', title: label('重新命名目前檔案', 'Rename current file'), run: () => { void renameTab(); } },
    { id: 'reload', title: label('從磁碟重新載入', 'Reload from disk'), run: () => { void reloadTab(); } },
    { id: 'refresh', title: label('重新整理專案檔案', 'Refresh workspace files'), run: () => { void run(refresh); } },
    { id: 'quick-open', title: label('快速開檔', 'Quick Open'), detail: shortcut('⌘P'), run: () => showPalette('files') },
    { id: 'split', title: label('切換左右分割', 'Toggle split editor'), detail: shortcut('⌘\\'), run: () => {
      send({ type: 'setting', key: 'split', value: !state.split }); if (state.split) setPane('primary');
    } },
    { id: 'git', title: label('開啟 Git 介面', 'Open Git panel'), run: () => { setGitOpen(true); send({ type: 'setting', key: 'sidebar', value: true }); } },
    { id: 'terminal', title: label('切換終端機', 'Toggle terminal'), detail: shortcut('⌘`'), run: () => { setTerminalStarted(true); setTerminalVisible(value => !value); } },
    { id: 'search', title: label('搜尋專案內容', 'Search workspace'), detail: shortcut('⌘⇧F'), run: () => { setGitOpen(false); setSearchDirectory(''); setSearch(true); send({ type: 'setting', key: 'sidebar', value: true }); } },
    { id: 'sidebar', title: label('切換側邊欄', 'Toggle sidebar'), detail: shortcut('⌘B'), run: () => send({ type: 'setting', key: 'sidebar', value: !state.sidebar }) },
    { id: 'minimap', title: label('切換 minimap 縮圖', 'Toggle minimap'), run: () => send({ type: 'setting', key: 'minimap', value: !state.minimap }) },
    { id: 'preview', title: label('切換 Markdown 預覽', 'Toggle Markdown preview'), run: () => send({ type: 'setting', key: 'preview', value: !state.preview }) },
    { id: 'language', title: label('切換介面語言', 'Switch interface language'), run: () => send({ type: 'setting', key: 'english', value: !state.english }) },
  ];
  useEffect(() => {
    setIndexedFiles([]);
    if ((palette !== 'files' && palette !== 'compare') || !state.root) return;
    let cancelled = false;
    void invoke<string[]>('list_files').then(paths => {
      if (!cancelled) setIndexedFiles(paths);
    }, error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [palette, state.root, files]);
  const paletteEntries = palette === 'compare'
    ? [
      ...state.tabs.filter(tab => tab.id !== compareSource && (!paletteQuery || (tab.path || label('未命名', 'Untitled')).toLowerCase().includes(paletteQuery.toLowerCase())))
        .map(tab => ({ id: tab.id, title: tab.path || label('未命名', 'Untitled'), detail: label('開啟的分頁（含未儲存內容）', 'Open tab (includes unsaved changes)'), run: () => { const left = current.current.tabs.find(t => t.id === compareSource); if (left) setComparison({ left: { ...left }, right: { ...tab } }); } })),
      ...fuzzyPaths([...new Set([...indexedFiles, ...files])], paletteQuery).filter(path => !state.tabs.some(tab => tab.path === path))
        .map(path => ({ id: path, title: path, detail: label('工作區檔案', 'Workspace file'), run: () => { void compareWithPath(path); } })),
    ]
    : palette === 'files'
    ? fuzzyPaths([...new Set([...indexedFiles, ...files])], paletteQuery).map(path => ({ id: path, title: path.split('/').pop()!, detail: path, run: () => { void openFile(path); } }))
    : commands.filter(c => `${c.title} ${c.id}`.toLowerCase().includes(paletteQuery.toLowerCase()));

  useEffect(() => {
    const client = new LspBridge({
      state: () => current.current,
      change: (id, text) => send({ type: 'edit', id, text }),
      read: path => readDocument(path),
      insert: (path, text, encoding) => {
        const existing = current.current.tabs.find(t => t.path === path);
        if (existing) return existing;
        if (current.current.tabs.length >= 100) throw new Error('A maximum of 100 tabs can be opened');
        const tab: Tab = { id: newId(), path, text, original: text, language: null, encoding };
        send({ type: 'insert', tab }); return tab;
      },
      open: (path, position) => openFile(path, focusedPane.current, position),
    }, setLspStatus);
    client.register(); bridge.current = client;
    let cancelled = false;
    void invoke<LspSettingsData>('load_lsp_settings').then(settings => { if (!cancelled) setLspSettings(settings); })
      .catch(error => { if (!cancelled) setError(`LSP: ${String(error)}`); });
    return () => { cancelled = true; client.dispose(); bridge.current = null; };
  }, []);
  useEffect(() => { bridge.current?.configure(ready ? lspSettings : null, ready ? state.root : ''); }, [lspSettings, state.root, ready]);
  useEffect(() => {
    if (!ready || !lspSettings) return;
    const timer = setTimeout(() => bridge.current?.updateDocuments(current.current.tabs), 200);
    return () => clearTimeout(timer);
  }, [state.tabs, state.root, ready, lspSettings]);

  // Restore clean tabs from disk and keep dirty buffers with their old conflict baseline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await invoke<unknown>('load_session');
        const snapshot = normalizeSession(raw);
        if (raw !== null && !snapshot) throw new Error('Unsupported session recovery data');
        if (!snapshot) return;
        if (snapshot.root) {
          const info = await invoke<WorkspaceInfo>('open_workspace', { path: snapshot.root });
          if (cancelled) return;
          setFiles(info.files); setDirectories(info.directories ?? []); setRootInput(info.root); snapshot.root = info.root;
          let conflicts = false;
          for (let i = 0; i < snapshot.tabs.length; i++) {
            const tab = snapshot.tabs[i];
            if (!tab.path) continue;
            let disk: string | null = null;
            try { const doc = await readDocument(tab.path, tab.encoding); disk = doc.text; if (!isDirty(tab)) tab.encoding = doc.encoding; } catch { /* Keep recovery text. */ }
            const result = recoverTab(tab, disk);
            snapshot.tabs[i] = result.tab;
            conflicts ||= result.conflict;
          }
          if (conflicts) setError(snapshot.english ? 'Recovered unsaved files. Some disk files changed or are missing; use Save As to preserve both versions.' : '已復原未儲存內容。部分磁碟檔案已變更或遺失，可另存新檔以保留兩個版本。');
        }
        if (!cancelled) {
          send({ type: 'restore', session: snapshot });
          await getCurrentWindow().setSize(new LogicalSize(snapshot.width, snapshot.height));
        }
      } catch (e) {
        if (!cancelled) {
          recoveryEnabled.current = false;
          setError(`工作階段復原失敗；原備份保持不變。請重新開啟專案。 / Recovery failed; backup preserved. ${String(e)}`);
        }
      } finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !recoveryEnabled.current || closing.current) return;
    const timer = setTimeout(() => { if (closing.current) return; void checkpoint(state).catch(e => setError(`工作階段備份失敗 / Session backup failed: ${String(e)}`)); }, 700);
    return () => clearTimeout(timer);
  }, [state, ready]);

  useEffect(() => {
    const resized = () => send({ type: 'size', width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);

  const actions = useRef({ requestClose: async () => {}, keydown: (_event: KeyboardEvent) => {} });
  actions.current.requestClose = async () => {
    if (!ready || closing.current) return;
    if (aiBusy.current) {
      try { await invoke('ai_stop'); aiBusy.current = false; busy.current = false; setWorking(false); }
      catch (error) { setError(String(error)); return; }
    }
    if (busy.current) return;
    if (comparison) { setComparison(null); return; }
    if (lspSettingsOpen) { setLspSettingsOpen(false); return; }
    closing.current = true;
    try {
      const discarded = new Set<string>();
      if (!await confirmTabs(current.current.tabs, discarded)) return;
      const snapshot = closeSnapshot(current.current, discarded);
      if (recoveryEnabled.current) await checkpoint(snapshot);
      await getCurrentWindow().destroy();
    } catch (e) { setError(String(e)); }
    finally { closing.current = false; }
  };
  actions.current.keydown = event => {
    if (!ready || busy.current || closing.current || dialog || palette || comparison || lspSettingsOpen || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = key === 'p' ? () => showPalette(event.shiftKey ? 'commands' : 'files')
      : key === 's' ? () => { if (activeTab) void saveTab(activeTab.id, event.shiftKey); }
      : key === 'o' ? () => { void promptWorkspace(); }
      : key === 'n' ? newFile
      : key === 'w' ? () => { if (activeTab) void closeTab(activeTab.id); }
      : key === 'b' ? () => send({ type: 'setting', key: 'sidebar', value: !state.sidebar })
      : key === '\\' ? commands.find(c => c.id === 'split')!.run
      : key === '`' ? commands.find(c => c.id === 'terminal')!.run
      : key === 'f' && event.shiftKey ? commands.find(c => c.id === 'search')!.run : undefined;
    if (action) { event.preventDefault(); event.stopPropagation(); action(); }
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => actions.current.keydown(event);
    window.addEventListener('keydown', keydown, true);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!closing.current && current.current.tabs.some(isDirty)) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => {
      event.preventDefault(); void actions.current.requestClose();
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(e => setError(String(e)));
    return () => { disposed = true; unlisten?.(); window.removeEventListener('keydown', keydown, true); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!search || !state.root || !searchQuery) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void invoke<SearchMatch[]>('search_files', { query: searchQuery, caseSensitive, directory: searchDirectory, encoding: searchEncoding }).then(matches => {
        if (!cancelled) setResults(matches);
      }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); void invoke('cancel_search').catch(() => {}); };
  }, [search, searchQuery, caseSensitive, searchDirectory, searchEncoding, state.root]);

  function applyJump() {
    const position = jump.current;
    if (!position) return;
    const snapshot = current.current;
    const id = position.pane === 'primary' ? snapshot.active : snapshot.secondary;
    if (snapshot.tabs.find(t => t.id === id)?.path !== position.path) return;
    const editor = editorRefs.current[position.pane];
    if (!editor) return;
    editor.setPosition({ lineNumber: position.line, column: position.column });
    editor.revealLineInCenter(position.line); editor.focus(); jump.current = null;
  }
  useEffect(() => { const frame = requestAnimationFrame(applyJump); return () => cancelAnimationFrame(frame); }, [state.active, state.secondary, state.tabs.length]);
  // Dispose closed buffers only after editors have switched models; shared split models stay alive.
  useEffect(() => {
    const paths = new Set(state.tabs.map(t => monaco.Uri.parse(editorModelPath(state.root, t.id, t.path, t.language)).toString()));
    const attached = new Set(Object.values(editorRefs.current).map(editor => editor?.getModel()).filter(Boolean));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === 'editor' && !paths.has(model.uri.toString()) && !attached.has(model)) model.dispose();
    }
  }, [state.tabs, state.root]);

  function paneView(tab: Tab | undefined, target: Pane) {
    return <div className={`editor-pane ${pane === target ? 'focused' : ''}`} onMouseDown={() => setPane(target)}>
      {target === 'secondary' && <select aria-label={label('右側檔案', 'Right editor file')} value={state.secondary} onChange={e => focusTab(e.target.value, 'secondary')}>
        {state.tabs.map(t => <option key={t.id} value={t.id}>{t.path || label('未命名', 'Untitled')}{isDirty(t) ? ' ●' : ''}</option>)}
      </select>}
      {tab ? <CodePane key={`${state.root}:${target}`} tab={tab} scope={state.root} minimap={state.minimap} readOnly={!ready || working || !!dialog || lspSettingsOpen || closing.current}
        change={(id, text) => send({ type: 'edit', id, text })}
        focused={() => setPane(target)} mounted={editor => { editorRefs.current[target] = editor; if (editor) requestAnimationFrame(applyJump); }} />
        : <div className="welcome"><h1>Free Code Editor</h1><p>{label('開啟專案，開始編輯。', 'Open a workspace to begin.')}</p><p>{shortcut('⌘O · ⌘P · ⌘⇧P')}</p></div>}
    </div>;
  }

  return <>
    <div className="app-shell" inert={dialog !== null || palette !== null || lspSettingsOpen || comparison !== null}>
    <header>
      <b>FREE CODE</b>
      <input aria-label={label('專案路徑', 'Workspace path')} placeholder={label('檔案或專案絕對路徑', 'Absolute file or workspace path')}
        value={rootInput} onChange={e => setRootInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void openWorkspace(); }} />
      <button disabled={!ready || working} onClick={() => { void openWorkspace(); }}>{label('開啟', 'Open')}</button>
      <button disabled={!ready || working} onClick={newFile}>{label('新增', 'New')}</button>
      <button disabled={working || !activeTab} onClick={() => { if (activeTab) void saveTab(activeTab.id); }}>{label('儲存', 'Save')}</button>
      <button disabled={!ready} onClick={() => showPalette('commands')}>{shortcut('⌘⇧P')}</button>
      <button disabled={!state.root} onClick={commands.find(c => c.id === 'terminal')!.run}>{label('終端機', 'Terminal')}</button>
      <button title={serviceStatus} onClick={() => { void showLspSettings(); }}>LSP</button>
      <button onClick={() => send({ type: 'setting', key: 'english', value: !state.english })}>繁中 / EN</button>
    </header>
    <main aria-busy={!ready || working}>
      {state.sidebar && <aside className="explorer-sidebar">
        <div className="sidebar-tabs"><button className={!search && !gitOpen ? 'active' : ''} onClick={() => { setGitOpen(false); setSearch(false); }}>{label('檔案', 'Files')}</button>
          <button className={search && !gitOpen ? 'active' : ''} onClick={() => { setGitOpen(false); setSearch(true); }}>{label('搜尋', 'Search')}</button><button className={gitOpen ? 'active' : ''} onClick={() => setGitOpen(true)}>Git</button></div>
        {gitOpen ? <GitPanel key={state.root} root={state.root} english={state.english}
          compare={(left, right) => setComparison({ left, right })} open={path => { void openFile(path); }} /> : search ? <div className="explorer-search">
          {searchDirectory && <div className="search-scope" title={searchDirectory}>
            <span>{label('搜尋範圍：', 'Folder: ')}{searchDirectory}</span>
            <button onClick={() => setSearchDirectory('')}>{label('整個工作區', 'Entire workspace')}</button>
          </div>}
          <input aria-label={label('搜尋專案內容', 'Search workspace')} autoFocus placeholder={label('搜尋專案內容…', 'Search workspace…')}
            value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          <select aria-label={label('搜尋編碼', 'Search encoding')} value={searchEncoding} onChange={event => setSearchEncoding(event.target.value as TextEncoding)}>{encodingChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          <label className="search-option"><input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />{label('區分大小寫', 'Case sensitive')}</label>
          <small>{searching ? label('搜尋中…', 'Searching…') : `${results.length}${results.length === 500 ? '+' : ''} ${label('筆結果', 'results')}`}</small>
          {results.map(result => <button className="search-result" key={`${result.path}:${result.line}`} onClick={() => { void openFile(result.path, pane, result, searchEncoding); }}>
            <strong>{result.path}:{result.line}</strong><span>{result.preview}</span></button>)}
        </div> : <>
          <section className="explorer-open-files" aria-label={label('開啟的檔案', 'Open files')}>
            <h2 className="explorer-heading">{label('開啟的檔案', 'OPEN FILES')}</h2>
            <div className="explorer-open-list">
              {state.tabs.map(tab => <div key={tab.id} className={`explorer-open-row${activeId === tab.id ? ' is-selected' : ''}`}>
                <button className="explorer-open-file" title={tab.path || label('未命名', 'Untitled')}
                  aria-current={activeId === tab.id ? 'true' : undefined} onClick={() => focusTab(tab.id)}>
                  <ExplorerIcon kind="file" /><span>{tab.path.split('/').pop() || label('未命名', 'Untitled')}</span>
                </button>
                <button className={`explorer-close${isDirty(tab) ? ' is-dirty' : ''}`} disabled={working}
                  aria-label={`${label('關閉', 'Close')} ${tab.path || label('未命名', 'Untitled')}`}
                  onClick={() => { void closeTab(tab.id); }}>{isDirty(tab) ? '●' : '×'}</button>
              </div>)}
            </div>
          </section>
          <h2 className="explorer-heading">{label('資料夾', 'FOLDERS')}</h2>
          <div className="explorer-filter"><input aria-label={label('篩選檔名', 'Filter files')} placeholder={label('篩選檔案與資料夾…', 'Filter files and folders…')}
            value={pathFilter} onChange={e => setPathFilter(e.target.value)} /></div>
          <FileTree key={state.root} root={state.root} files={files} directories={directories} activePath={activeTab?.path ?? ''}
            findInFolder={path => { setGitOpen(false); setSearchDirectory(path); setResults([]); setSearch(true); }} loadDirectory={loadTreeDirectory} filter={pathFilter} english={state.english} open={path => { void openFile(path); }} disabled={!ready || working} />
        </>}
      </aside>}
      <section className="workspace">
        <nav>
          <button aria-pressed={aiOpen} disabled={working} onClick={() => setAiOpen(!aiOpen)}>AI</button>
          {state.tabs.map(tab => <div className={`tab ${activeId === tab.id ? 'active' : ''}`} key={tab.id}
            onContextMenu={event => { if (!ready || working) return; event.preventDefault(); setTabMenu({ id: tab.id, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 280)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 100)) }); }}>
            <button title={tab.path} onClick={() => focusTab(tab.id)}>{tab.path.split('/').pop() || label('未命名', 'Untitled')}{isDirty(tab) ? ' ●' : ''}</button>
            <button className="close-tab" aria-label={label('關閉分頁', 'Close tab')} onClick={() => { void closeTab(tab.id); }}>×</button>
          </div>)}
          <button title={label('左右分割', 'Split editor')} onClick={commands.find(c => c.id === 'split')!.run}>◫</button>
          <button aria-pressed={state.minimap} title={label('切換 minimap 縮圖', 'Toggle minimap')} onClick={commands.find(c => c.id === 'minimap')!.run}>{label('縮圖', 'Minimap')}</button>
          <button title="Markdown" onClick={commands.find(c => c.id === 'preview')!.run}>M↓</button>
        </nav>
        <div className="panes">
          {paneView(primary, 'primary')}
          {state.split && paneView(secondary, 'secondary')}
          {activeTab && state.preview && (activeTab.language ?? languageForPath(activeTab.path)) === 'markdown' &&
            <MarkdownPreview key={`${state.root}:${activeTab.id}`} text={activeTab.text} document={activeTab.path} english={state.english} report={setError} />}
        </div>
        {terminalStarted && state.root && <TerminalPanel key={state.root} root={state.root} english={state.english} visible={terminalVisible} hide={() => setTerminalVisible(false)} />}
      </section>
      {aiOpen && <AiPanel key={state.root} root={state.root} close={() => setAiOpen(false)}
        snapshot={() => { const editor = editorRefs.current[focusedPane.current]; const selection = editor?.getSelection(); return { tabs: current.current.tabs, active: current.current.tabs.find(tab => tab.id === (focusedPane.current === 'secondary' && current.current.split ? current.current.secondary : current.current.active)), selection: selection && editor?.getModel()?.getValueInRange(selection) || '' }; }}
        running={value => {
          if (value) { if (busy.current) throw new Error('請等待目前操作完成'); aiBusy.current = true; }
          else if (!aiBusy.current) return;
          else aiBusy.current = false;
          busy.current = value; setWorking(value);
        }}
        completed={async deleted => {
          const workspace = current.current.root;
          for (const tab of [...current.current.tabs]) {
            if (!tab.path || isDirty(tab)) continue;
            if (deleted.includes(tab.path)) { send({ type: 'close', id: tab.id }); continue; }
            try { const doc = await readDocument(tab.path, tab.encoding); if (current.current.root === workspace) send({ type: 'reload', id: tab.id, ...doc }); }
            catch (error) { setError(String(error)); }
          }
          if (current.current.root === workspace) { await refresh(); setIndexedFiles([]); }
        }} />}
    </main>
    <footer><span role="status">{error || (!ready ? label('復原工作階段…', 'Restoring session…') : working ? label('處理中…', 'Working…') : activeTab?.path || label('就緒', 'Ready'))}</span>
      {activeTab && <select aria-label={label('檔案語言', 'File language')} value={activeTab.language ?? 'auto'} onChange={e => send({ type: 'language', id: activeTab.id, language: e.target.value === 'auto' ? null : e.target.value })}>
        <option value="auto">{label('自動', 'Auto')}: {languageForPath(activeTab.path)}</option>{languageIds.map(id => <option key={id}>{id}</option>)}
      </select>}<span className="lsp-status" title={serviceStatus}>LSP: {serviceStatus}</span>{activeTab ? <select aria-label={label('檔案編碼（重新開啟）', 'File encoding (reopen)')} title={label('依所選編碼重新開啟；另存新檔可轉換編碼', 'Reopen with selected encoding; Save As converts encoding')} disabled={working} value={activeTab.encoding ?? 'utf8'} onChange={event => { void reopenEncoding(event.target.value as TextEncoding); }}>{encodingChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : <span>UTF-8</span>}</footer>
    </div>
    {tabMenu && <div ref={tabMenuRef} role="menu" className="folder-context-menu tab-context-menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
      <button role="menuitem" onClick={() => { setCompareSource(tabMenu.id); setPaletteQuery(''); setPalette('compare'); setTabMenu(null); }}>{label('選擇檔案比較…', 'Compare with…')}</button>
      <button role="menuitem" disabled={!activeTab || activeTab.id === tabMenu.id} onClick={() => {
        const left = state.tabs.find(tab => tab.id === tabMenu.id);
        if (left && activeTab && left.id !== activeTab.id) setComparison({ left: { ...left }, right: { ...activeTab } });
        setTabMenu(null);
      }}>{label('與目前分頁比較', 'Compare with active tab')}</button>
    </div>}
    {comparison && <CompareView {...comparison} english={state.english} close={() => setComparison(null)} />}
    {palette && <Palette title={palette === 'compare' ? label('選擇比較檔案', 'Compare with…') : palette === 'files' ? label('快速開檔', 'Quick Open') : label('命令面板', 'Command Palette')}
      query={paletteQuery} change={setPaletteQuery} entries={paletteEntries} close={() => setPalette(null)} />}
    {lspSettingsOpen && lspSettings && <LspSettings settings={lspSettings} english={state.english} status={lspStatus}
      close={() => setLspSettingsOpen(false)} save={async settings => {
        await invoke('save_lsp_settings', { settings }); setLspSettings(settings);
      }} />}
    {dialog && <Dialog key={dialog.title} spec={dialog} done={finishDialog} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
