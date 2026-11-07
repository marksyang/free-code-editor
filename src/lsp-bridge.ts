import { Channel, invoke } from '@tauri-apps/api/core';
import { monaco } from './monaco';
import { languageForPath, lspLanguages, editorModelPath } from './languages';
import { markdown, object, range, textEdit, validateEdits, workspaceEdits, serverKey } from './lsp-protocol';
import type { LspSettings, Range } from './lsp-protocol';
import type { Session, Tab } from './editor-state';

type Context = {
  state: () => Session;
  insert: (path: string, text: string) => Tab;
  change: (id: string, text: string) => void;
  open: (path: string, position: { line: number; column: number }) => Promise<void>;
};
type Peer = { serverId: string; capabilities: Record<string, unknown>; key: string; root: string; generation: number };
type Document = { id: string; path: string; uri: string; text: string; language: string; version: number; peer: Peer };
type ServerEvent = { serverId: string; method: string; params: unknown };
type RequestResult = { value: unknown; document: Document; modelVersion: number };
const feature: Record<string, string> = {
  'textDocument/completion': 'completionProvider', 'textDocument/hover': 'hoverProvider',
  'textDocument/definition': 'definitionProvider', 'textDocument/references': 'referencesProvider', 'textDocument/rename': 'renameProvider',
};
const modelUri = (root: string, tab: Pick<Tab, 'id' | 'path' | 'language'>) => monaco.Uri.parse(editorModelPath(root, tab.id, tab.path, tab.language));
const toRange = (r: Range): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
const toPosition = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const completionKinds = [monaco.languages.CompletionItemKind.Text, monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function, monaco.languages.CompletionItemKind.Constructor, monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable, monaco.languages.CompletionItemKind.Class, monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module, monaco.languages.CompletionItemKind.Property, monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value, monaco.languages.CompletionItemKind.Enum, monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet, monaco.languages.CompletionItemKind.Color, monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference, monaco.languages.CompletionItemKind.Folder, monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant, monaco.languages.CompletionItemKind.Struct, monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator, monaco.languages.CompletionItemKind.TypeParameter];

export class LspBridge {
  private settings: LspSettings | null = null;
  private root = '';
  private generation = 0;
  private peers = new Map<string, Promise<Peer | null>>();
  private failed = new Set<string>();
  private documents = new Map<string, Document>();
  private syncQueues = new Map<string, Promise<Document | null>>();
  private diagnostics = new Map<string, ServerEvent>();
  private disposables: monaco.IDisposable[] = [];
  private listeners = new Map<string, monaco.IDisposable>();
  private scratch = new Set<monaco.editor.ITextModel>();
  private statuses: Record<string, string> = {};
  private requests = new Map<string, Peer>();
  private builtin = {
    javascript: monaco.languages.typescript.javascriptDefaults.modeConfiguration,
    typescript: monaco.languages.typescript.typescriptDefaults.modeConfiguration,
    json: monaco.languages.json.jsonDefaults.modeConfiguration,
    css: monaco.languages.css.cssDefaults.modeConfiguration,
    html: monaco.languages.html.htmlDefaults.modeConfiguration,
  };
  constructor(private context: Context, private changed: (status: Record<string, string>) => void) {}

  configure(settings: LspSettings | null, root: string) {
    if (this.settings === settings && this.root === root) return;
    this.clear(); this.settings = settings; this.root = root;
  }
  private status(key: string, message: string) {
    this.statuses = { ...this.statuses, [key]: message }; this.changed(this.statuses);
  }
  private fallback(key: string, external: boolean) {
    if (key === 'javascript') monaco.languages.typescript.javascriptDefaults.setModeConfiguration(external
      ? { ...this.builtin.javascript, completionItems: false, hovers: false, definitions: false, references: false, rename: false, diagnostics: false } : this.builtin.javascript);
    if (key === 'javascript') monaco.languages.typescript.typescriptDefaults.setModeConfiguration(external
      ? { ...this.builtin.typescript, completionItems: false, hovers: false, definitions: false, references: false, rename: false, diagnostics: false } : this.builtin.typescript);
    if (key === 'json') monaco.languages.json.jsonDefaults.setModeConfiguration(external
      ? { ...this.builtin.json, completionItems: false, hovers: false, diagnostics: false } : this.builtin.json);
    if (key === 'css') monaco.languages.css.cssDefaults.setModeConfiguration(external
      ? { ...this.builtin.css, completionItems: false, hovers: false, definitions: false, references: false, rename: false, diagnostics: false } : this.builtin.css);
    if (key === 'html') monaco.languages.html.htmlDefaults.setModeConfiguration(external
      ? { ...this.builtin.html, completionItems: false, hovers: false, rename: false, diagnostics: false } : this.builtin.html);
  }
  private tab(model: monaco.editor.ITextModel): Tab | undefined {
    const state = this.context.state();
    if (state.root !== this.root) return;
    return state.tabs.find(tab => modelUri(state.root, tab).toString() === model.uri.toString());
  }
  private model(tab: Tab) { return monaco.editor.getModel(modelUri(this.root, tab)); }
  private enabled(tab: Tab) {
    const key = serverKey(tab.language ?? languageForPath(tab.path));
    return Boolean(this.root && tab.path && tab.original !== null && this.settings?.enabled && key && this.settings.servers[key]?.enabled);
  }
  private async peer(language: string): Promise<Peer | null> {
    const key = serverKey(language);
    if (!key || !this.settings?.enabled || !this.settings.servers[key]?.enabled || this.failed.has(key) || !this.root) return null;
    const existing = this.peers.get(key); if (existing) return existing;
    const root = this.root, generation = this.generation;
    const promise = (async () => {
      this.status(key, 'Starting / 啟動中');
      const channel = new Channel<ServerEvent>();
      channel.onmessage = event => { if (generation === this.generation) this.event(event); };
      try {
        const started = await invoke<{ serverId: string; capabilities: Record<string, unknown> }>('start_lsp', { expectedRoot: root, language, onEvent: channel });
        if (generation !== this.generation) return null;
        const peer = { ...started, key, root, generation };
        this.status(key, 'Connected / 已連線'); this.fallback(key, true); return peer;
      } catch (error) {
        if (generation === this.generation) { this.failed.add(key); this.status(key, String(error)); this.fallback(key, false); }
        return null;
      }
    })();
    this.peers.set(key, promise); return promise;
  }
  private async syncTab(tab: Tab): Promise<Document | null> {
    if (!this.enabled(tab)) return null;
    const generation = this.generation;
    const previous = this.syncQueues.get(tab.id) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(async () => {
      if (generation !== this.generation) return null;
      const latest = this.context.state().tabs.find(t => t.id === tab.id);
      if (!latest || !this.enabled(latest)) return null;
      const language = latest.language ?? languageForPath(latest.path);
      const peer = await this.peer(language); if (!peer || generation !== this.generation) return null;
      const old = this.documents.get(tab.id);
      if (old?.peer === peer && old.path === latest.path && old.language === language && old.text === latest.text) return old;
      if (old && (old.path !== latest.path || old.peer !== peer || old.language !== language)) await this.close(old);
      const stamp = await invoke<{ uri: string; version: number }>('sync_lsp_document', {
        expectedRoot: peer.root, serverId: peer.serverId, path: latest.path, language, text: latest.text,
      });
      if (generation !== this.generation || !this.context.state().tabs.some(t => t.id === tab.id && t.path === latest.path)) {
        void invoke('close_lsp_document', { expectedRoot: peer.root, serverId: peer.serverId, uri: stamp.uri }).catch(() => {}); return null;
      }
      const document = { ...stamp, id: latest.id, path: latest.path, text: latest.text, language, peer };
      this.documents.set(latest.id, document);
      const scratch = monaco.editor.getModel(monaco.Uri.parse(document.uri));
      if (scratch && this.scratch.has(scratch) && scratch.getValue() !== latest.text) scratch.setValue(latest.text);
      const event = this.diagnostics.get(document.uri); if (event) this.applyDiagnostics(event);
      return document;
    }).catch(error => {
      if (generation === this.generation) { const key = serverKey(tab.language ?? languageForPath(tab.path)); if (key) this.status(key, String(error)); }
      return null;
    });
    this.syncQueues.set(tab.id, next); return next;
  }
  private async close(document: Document) {
    if (this.documents.get(document.id) !== document) return;
    this.documents.delete(document.id); this.diagnostics.delete(document.uri);
    const tab = this.context.state().tabs.find(t => t.id === document.id);
    const model = tab && this.model(tab); if (model) monaco.editor.setModelMarkers(model, 'lsp', []);
    await invoke('close_lsp_document', { expectedRoot: document.peer.root, serverId: document.peer.serverId, uri: document.uri }).catch(() => {});
  }
  async saved(id: string, text: string) {
    const tab = this.context.state().tabs.find(t => t.id === id);
    if (!tab || tab.text !== text) return;
    const document = await this.syncTab(tab);
    if (document && document.peer.generation === this.generation && document.text === text) {
      await invoke('saved_lsp_document', { expectedRoot: document.peer.root, serverId: document.peer.serverId, uri: document.uri }).catch(() => {});
    }
  }
  updateDocuments(tabs: Tab[]) {
    for (const document of this.documents.values()) {
      if (!tabs.some(t => t.id === document.id && this.enabled(t))) {
        const previous = this.syncQueues.get(document.id) ?? Promise.resolve(null);
        const closing = previous.catch(() => null).then(async () => {
          const current = this.documents.get(document.id);
          if (current && !this.context.state().tabs.some(t => t.id === document.id && this.enabled(t))) await this.close(current);
          return null;
        });
        this.syncQueues.set(document.id, closing);
      }
    }
    for (const tab of tabs) if (this.enabled(tab)) void this.syncTab(tab);
  }
  private event(event: ServerEvent) {
    if (event.method === 'textDocument/publishDiagnostics') {
      const params = object(event.params);
      if (typeof params?.uri !== 'string') return;
      this.diagnostics.set(params.uri, event); this.applyDiagnostics(event);
    } else if (event.method === 'client/stopped') {
      void Promise.all(this.peers.values()).then(peers => {
        const peer = peers.find(p => p?.serverId === event.serverId);
        if (!peer || peer.generation !== this.generation) return;
        this.failed.add(peer.key); this.status(peer.key, String(object(event.params)?.message ?? 'Stopped / 已停止')); this.fallback(peer.key, false);
        for (const doc of this.documents.values()) if (doc.peer === peer) {
          const model = monaco.editor.getModel(modelUri(peer.root, { id: doc.id, path: doc.path, language: doc.language })); if (model) monaco.editor.setModelMarkers(model, 'lsp', []);
        }
      });
    }
  }
  private applyDiagnostics(event: ServerEvent) {
    const params = object(event.params);
    const document = [...this.documents.values()].find(d => d.uri === params?.uri && d.peer.serverId === event.serverId);
    if (!document || document.peer.generation !== this.generation) return;
    const tab = this.context.state().tabs.find(t => t.id === document.id);
    if (!tab || tab.text !== document.text || (typeof params?.version === 'number' && params.version !== document.version)) return;
    const model = this.model(tab); if (!model || model.getValue() !== document.text) return;
    const diagnostics = Array.isArray(params?.diagnostics) ? params.diagnostics.slice(0, 500) : [];
    const markers: monaco.editor.IMarkerData[] = diagnostics.flatMap(value => {
      const entry = object(value), r = range(entry?.range); if (!r || typeof entry?.message !== 'string') return [];
      const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][Number(entry.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Info;
      return [{ ...toRange(r), severity, message: entry.message.slice(0, 8000),
        source: typeof entry.source === 'string' ? entry.source.slice(0, 100) : 'LSP',
        code: typeof entry.code === 'string' || typeof entry.code === 'number' ? String(entry.code) : undefined }];
    });
    monaco.editor.setModelMarkers(model, 'lsp', markers);
  }
  private async request(model: monaco.editor.ITextModel, method: string, params: Record<string, unknown>, token: monaco.CancellationToken): Promise<RequestResult | null> {
    const tab = this.tab(model); if (!tab || !this.enabled(tab)) return null;
    const generation = this.generation, version = model.getVersionId();
    const document = await this.syncTab(tab);
    if (!document || generation !== this.generation || model.isDisposed() || version !== model.getVersionId() || token.isCancellationRequested || !document.peer.capabilities[feature[method]]) return null;
    const requestId = crypto.randomUUID(), peer = document.peer;
    const cancel = () => { void invoke('cancel_lsp_request', { expectedRoot: peer.root, serverId: peer.serverId, requestId }).catch(() => {}); };
    const listener = token.onCancellationRequested(cancel);
    this.requests.set(requestId, peer);
    try {
      if (token.isCancellationRequested) return null;
      const value = await invoke<unknown>('lsp_request', { expectedRoot: peer.root, request: { serverId: peer.serverId, requestId, method, path: tab.path, params } });
      if (generation !== this.generation || model.isDisposed() || version !== model.getVersionId() || token.isCancellationRequested) return null;
      return { value, document, modelVersion: version };
    } catch (error) {
      if (!token.isCancellationRequested && generation === this.generation) this.status(peer.key, String(error));
      return null;
    } finally { listener.dispose(); this.requests.delete(requestId); }
  }
  private async locations(value: unknown, root: string): Promise<monaco.languages.Location[]> {
    const entries = Array.isArray(value) ? value.slice(0, 100) : value ? [value] : [];
    const result: monaco.languages.Location[] = [];
    for (const value of entries) {
      const entry = object(value), uri = entry?.targetUri ?? entry?.uri, r = range(entry?.targetSelectionRange ?? entry?.range);
      if (typeof uri !== 'string' || !r) continue;
      try {
        const path = await invoke<string>('lsp_document_path', { expectedRoot: root, uri });
        if (root !== this.root) return [];
        const existing = this.context.state().tabs.find(t => t.path === path);
        const text = existing?.text ?? await invoke<string>('read_file', { path });
        if (root !== this.root) return [];
        const resource = monaco.Uri.parse(uri);
        let model = monaco.editor.getModel(resource);
        if (!model) { model = monaco.editor.createModel(text, languageForPath(path), resource); this.scratch.add(model); }
        else if (this.scratch.has(model) && model.getValue() !== text) model.setValue(text);
        result.push({ uri: resource, range: toRange(r) });
      } catch { /* System headers and resources outside this workspace are not opened. */ }
    }
    return result;
  }
  private listen(model: monaco.editor.ITextModel) {
    if (model.uri.scheme !== 'editor' || this.listeners.has(model.uri.toString())) return;
    const uri = model.uri.toString();
    const listener = model.onDidChangeContent(() => {
      const tab = this.tab(model);
      if (tab && tab.text !== model.getValue()) this.context.change(tab.id, model.getValue());
      monaco.editor.setModelMarkers(model, 'lsp', []);
    });
    this.listeners.set(uri, listener);
    model.onWillDispose(() => { listener.dispose(); this.listeners.delete(uri); });
    const tab = this.tab(model), doc = tab && this.documents.get(tab.id);
    if (doc) { const event = this.diagnostics.get(doc.uri); if (event) this.applyDiagnostics(event); }
  }
  register() {
    for (const language of lspLanguages) {
      this.disposables.push(monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', ':', '>', '/', '"', "'"],
        provideCompletionItems: async (model, position, context, token) => {
          const response = await this.request(model, 'textDocument/completion', { position: toPosition(position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } }, token);
          if (!response) return;
          const result = object(response.value), values = Array.isArray(response.value) ? response.value : Array.isArray(result?.items) ? result.items : [];
          const word = model.getWordUntilPosition(position);
          const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          const suggestions: monaco.languages.CompletionItem[] = values.slice(0, 1000).flatMap(value => {
            const item = object(value); if (typeof item?.label !== 'string') return [];
            const edit = object(item.textEdit), editRange = range(edit?.range ?? edit?.replace);
            const additional = Array.isArray(item.additionalTextEdits) ? item.additionalTextEdits.map(textEdit).filter(e => e !== null) : [];
            return [{ label: item.label, kind: completionKinds[Number(item.kind) - 1] ?? monaco.languages.CompletionItemKind.Text,
              range: editRange ? toRange(editRange) : defaultRange,
              insertText: typeof edit?.newText === 'string' ? edit.newText : typeof item.insertText === 'string' ? item.insertText : item.label,
              insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              detail: typeof item.detail === 'string' ? item.detail : undefined,
              documentation: markdown(item.documentation)[0], sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
              filterText: typeof item.filterText === 'string' ? item.filterText : undefined,
              additionalTextEdits: additional.map(e => ({ range: toRange(e.range), text: e.newText })),
            }];
          });
          return { suggestions, incomplete: result?.isIncomplete === true };
        },
      }));
      this.disposables.push(monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position, token) => {
          const response = await this.request(model, 'textDocument/hover', { position: toPosition(position) }, token);
          if (!response) return;
          const hover = object(response.value); if (!hover) return;
          const r = range(hover.range);
          return { contents: markdown(hover.contents), range: r ? toRange(r) : undefined };
        },
      }));
      this.disposables.push(monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position, token) => {
          const response = await this.request(model, 'textDocument/definition', { position: toPosition(position) }, token);
          if (!response) return;
          const locations = await this.locations(response.value, response.document.peer.root);
          return !token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === response.modelVersion ? locations : undefined;
        },
      }));
      this.disposables.push(monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (model, position, context, token) => {
          const response = await this.request(model, 'textDocument/references', { position: toPosition(position), context }, token);
          if (!response) return;
          const locations = await this.locations(response.value, response.document.peer.root);
          return !token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === response.modelVersion ? locations : undefined;
        },
      }));
      this.disposables.push(monaco.languages.registerRenameProvider(language, {
        provideRenameEdits: async (model, position, newName, token) => {
          const response = await this.request(model, 'textDocument/rename', { position: toPosition(position), newName }, token);
          if (!response) return;
          try {
            const groups = workspaceEdits(response.value), peer = response.document.peer;
            const prepared: { path: string; text: string; edits: ReturnType<typeof workspaceEdits>[number]['edits'] }[] = [];
            for (const group of groups) {
              const path = await invoke<string>('lsp_document_path', { expectedRoot: peer.root, uri: group.uri });
              const tab = this.context.state().tabs.find(t => t.path === path);
              const text = tab?.text ?? await invoke<string>('read_file', { path });
              const tracked = [...this.documents.values()].find(d => d.uri === group.uri && d.peer === peer);
              if (group.version !== null && (!tracked || tracked.version !== group.version || tracked.text !== text)) throw new Error('Rename document version changed');
              validateEdits(text, group.edits); prepared.push({ path, text, edits: group.edits });
            }
            if (peer.generation !== this.generation || model.isDisposed() || response.modelVersion !== model.getVersionId() || token.isCancellationRequested) return;
            for (const item of prepared) {
              const tab = this.context.state().tabs.find(t => t.path === item.path);
              if (tab && tab.text !== item.text) throw new Error('Document changed while preparing rename');
            }
            const state = this.context.state();
            if (state.tabs.length + prepared.filter(p => !state.tabs.some(t => t.path === p.path)).length > 100) throw new Error('Rename would exceed the 100-tab limit');
            const edits: monaco.languages.IWorkspaceTextEdit[] = [];
            for (const item of prepared) {
              const tab = this.context.insert(item.path, item.text), uri = modelUri(peer.root, tab);
              let target = monaco.editor.getModel(uri);
              if (!target) target = monaco.editor.createModel(item.text, tab.language ?? languageForPath(tab.path), uri);
              const versionId = target.getVersionId();
              edits.push(...item.edits.map(edit => ({ resource: uri, versionId, textEdit: { range: toRange(edit.range), text: edit.newText } })));
            }
            return { edits };
          } catch (error) { return { edits: [], rejectReason: String(error) }; }
        },
      }));
    }
    this.disposables.push(monaco.editor.onDidCreateModel(model => this.listen(model)));
    monaco.editor.getModels().forEach(model => this.listen(model));
    this.disposables.push(monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selection) => {
        if (resource.scheme !== 'file' || !this.root) return false;
        try {
          const path = await invoke<string>('lsp_document_path', { expectedRoot: this.root, uri: resource.toString() });
          const position = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn }
            : selection ? { line: selection.lineNumber, column: selection.column } : { line: 1, column: 1 };
          await this.context.open(path, position); return true;
        } catch { return false; }
      },
    }));
  }
  clear() {
    this.generation += 1;
    for (const [requestId, peer] of this.requests) void invoke('cancel_lsp_request', { expectedRoot: peer.root, serverId: peer.serverId, requestId }).catch(() => {});
    this.requests.clear(); this.peers.clear(); this.failed.clear(); this.documents.clear(); this.syncQueues.clear(); this.diagnostics.clear();
    for (const model of monaco.editor.getModels()) if (model.uri.scheme === 'editor') monaco.editor.setModelMarkers(model, 'lsp', []);
    for (const model of this.scratch) if (!model.isDisposed()) model.dispose();
    this.scratch.clear(); this.statuses = {}; this.changed({});
    ['javascript', 'json', 'css', 'html'].forEach(key => this.fallback(key, false));
  }
  dispose() {
    this.clear(); this.disposables.forEach(d => d.dispose()); this.listeners.forEach(d => d.dispose());
    this.disposables = []; this.listeners.clear();
  }
}
