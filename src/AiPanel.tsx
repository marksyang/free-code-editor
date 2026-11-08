import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { defaultAiSettings, validateSettings } from './ai-protocol';
import type { AiSettings } from './ai-protocol';
import type { Tab } from './editor-state';
import { CompareView } from './CompareView';

type Message = { role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: unknown[] };
type Change = { path: string; action: string; before?: string; after?: string };
type Approval = { id: string; operation: { name: string; preview: { changes?: Change[]; command?: string } } };
type Event = { taskId: string; workspace: string; sequence: number; kind: string; detail: unknown };
type Snapshot = { tabs: Tab[]; selection: string; active?: Tab };
export function AiPanel({ root, close, snapshot, running, completed }: {
  root: string; close: () => void; snapshot: () => Snapshot;
  running: (value: boolean) => void; completed: (deleted: string[]) => Promise<void>;
}) {
  const [settings, setSettings] = useState<AiSettings>(defaultAiSettings);
  const [status, setStatus] = useState('');
  const [ready, setReady] = useState(false);
  const [transport, setTransport] = useState(false);
  const [saving, setSaving] = useState(false);
  const [task, setTask] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const [authorize, setAuthorize] = useState(false);
  const [attach, setAttach] = useState(false);
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState('');
  const [records, setRecords] = useState<{ kind: string; detail: unknown }[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [comparison, setComparison] = useState<{ left: Tab; right: Tab } | null>(null);
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  const startTicket = useRef(0);
  const callbacks = useRef({ snapshot, running, completed }); callbacks.current = { snapshot, running, completed };
  const deleted = useRef<string[]>([]);
  const last = useRef(0);
  useEffect(() => {
    let live = true; mounted.current = true; let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<Event>('ai-event', ({ payload: event }) => {
          if (!live || event.workspace !== root || event.taskId !== active.current || event.sequence <= last.current) return;
          last.current = event.sequence;
          if (event.kind === 'delta') setPartial(previous => previous + String(event.detail));
          else if (event.kind === 'message') { setMessages(previous => [...previous, event.detail as Message]); setPartial(''); }
          else if (event.kind === 'approval') setApproval(event.detail as Approval);
          else if (event.kind === 'tool_result') {
            const result = event.detail as { id: string; result: unknown };
            setMessages(previous => [...previous, { role: 'tool', tool_call_id: result.id, content: JSON.stringify(result.result) }]);
            setRecords(previous => [...previous, { kind: event.kind, detail: event.detail }]);
          } else if (event.kind === 'files_changed') {
            const detail = event.detail as { result?: { files?: { path: string; action: string; success: boolean }[] } };
            deleted.current.push(...(detail.result?.files ?? []).filter(file => file.success && file.action === 'delete').map(file => file.path));
          } else if (['completed', 'failed', 'cancelled'].includes(event.kind)) {
            active.current = null; setApproval(null); setComparison(null); setAuthorize(false);
            setStatus(event.kind === 'completed' ? '任務完成' : event.kind === 'cancelled' ? '任務已停止；已完成的修改仍保留' : `任務失敗：${(event.detail as { error?: string }).error ?? ''}`);
            void callbacks.current.completed(deleted.current).catch(error => { if (live) setStatus(String(error)); }).finally(() => { callbacks.current.running(false); if (live) setTask(false); });
          } else setRecords(previous => [...previous, { kind: event.kind, detail: event.detail }]);
        });
        if (!live) { unlisten(); return; }
        const [config, availability, history] = await Promise.all([
          invoke<AiSettings>('load_ai_settings'), invoke<{ transport: boolean }>('ai_availability'),
          root ? invoke<Message[]>('ai_history', { workspaceRoot: root }) : Promise.resolve([]),
        ]);
        if (!live) return;
        setSettings(config); setTransport(availability.transport); setMessages(history);
        if (config.model) { const present = await invoke<boolean>('ai_has_key', { settings: config }); if (live) setHasKey(present); }
        if (live) setReady(true);
      } catch (error) { if (live) setStatus(String(error)); }
    })();
    return () => {
      live = false; mounted.current = false; unlisten?.();
      void invoke('ai_stop').catch(() => {});
      if (active.current) { void invoke('ai_cancel', { taskId: active.current }).catch(() => {}); callbacks.current.running(false); }
    };
  }, [root]);
  async function saveConfig() {
    const config = validateSettings(settings);
    await invoke('save_ai_settings', { settings: config });
    if (key) { await invoke('ai_set_key', { settings: config, key, remember }); setKey(''); }
    setHasKey(await invoke<boolean>('ai_has_key', { settings: config }));
    return config;
  }
  async function action(work: () => Promise<void>) {
    setSaving(true); setStatus('');
    try { await work(); } catch (error) { setStatus(String(error)); } finally { setSaving(false); }
  }
  async function start() {
    if (active.current || !root || !transport || !prompt.trim() || automatic && !authorize) return;
    const id = crypto.randomUUID();
    const ticket = ++startTicket.current;
    try {
      setSaving(true); await saveConfig();
      if (!mounted.current || ticket !== startTicket.current) throw new Error('已取消任務啟動');
      const current = callbacks.current.snapshot();
      const documents = current.tabs.filter(tab => !!tab.path).map(tab => ({ path: tab.path, text: tab.text.length <= 256 * 1024 ? tab.text : null, dirty: tab.original === null || tab.text !== tab.original, encoding: tab.encoding ?? 'utf8' }));
      const attachment = attach && current.active ? `${current.active.path || '未命名文件'}:\n${current.selection || current.active.text}` : null;
      active.current = id; last.current = 0; deleted.current = [];
      setTask(true); callbacks.current.running(true); setStatus('執行中'); setPartial(''); setRecords([]);
      setMessages(previous => [...previous, { role: 'user', content: prompt + (attachment ? `\n\nUser-attached context:\n${attachment}` : '') }]);
      await invoke('ai_start', { request: { taskId: id, workspaceRoot: root, prompt, automatic, automaticAuthorized: automatic && authorize, documents, attachment } });
      setPrompt('');
    } catch (error) {
      active.current = null; setTask(false); callbacks.current.running(false); setAuthorize(false); setStatus(String(error));
    } finally { setSaving(false); }
  }
  async function decide(approved: boolean) {
    if (!approval || !active.current) return;
    await action(async () => { await invoke('ai_approve', { taskId: active.current, callId: approval.id, approved }); setApproval(null); setComparison(null); });
  }
  function compare(change: Change) {
    const tab = (text: string, id: string): Tab => ({ id, path: change.path, text, original: text, language: null });
    setComparison({ left: tab(change.before ?? '', 'ai-before'), right: tab(change.action === 'delete' ? '' : change.after ?? '', 'ai-after') });
  }
  return <aside className="ai-panel" aria-label="AI 開發助手"><header><strong>AI 開發 Agent</strong><button onClick={close} disabled={task || saving} aria-label="關閉 AI 面板">×</button></header>
    <details><summary>模型與憑證設定</summary><form onSubmit={event => { event.preventDefault(); void action(async () => { await saveConfig(); setStatus('設定已保存'); }); }}>
      <fieldset disabled={!ready || saving || task}><legend>相容 API／Ollama</legend>
        <button type="button" onClick={() => { setSettings({ ...settings, endpoint: defaultAiSettings.endpoint }); setKey(''); setHasKey(false); }}>本機 Ollama</button>
        <label>API Base URL<input value={settings.endpoint} onChange={event => { setSettings({ ...settings, endpoint: event.target.value }); setHasKey(false); setKey(''); }} required /></label>
        <label><input type="checkbox" checked={settings.chatOnly ?? false} onChange={event => setSettings({ ...settings, chatOnly: event.target.checked })} />只聊天（模型不支援工具時使用）</label>
        <label>模型名稱<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} required /></label>
        <label>API Key（本機 Ollama 可留空）<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} /></label>
        <p>{hasKey ? '已有可用憑證；密鑰不會回傳介面。' : '尚未偵測到憑證。'}</p>
        <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />儲存至系統憑證庫（不勾選則僅本次程式執行有效）</label>
        <button type="button" onClick={() => { void action(async () => { await invoke('ai_delete_key', { settings: validateSettings(settings) }); setHasKey(false); setStatus('憑證已刪除'); }); }}>刪除憑證</button>
        <label>命令逾時（秒）<input type="number" min="1" max="3600" value={settings.commandTimeoutSeconds} onChange={event => setSettings({ ...settings, commandTimeoutSeconds: Number(event.target.value) })} required /></label>
        <button type="submit">保存設定</button><button type="button" onClick={() => { void action(async () => { const ticket = ++startTicket.current; const config = await saveConfig(); if (ticket !== startTicket.current || !mounted.current) throw new Error('已取消連線測試'); await invoke('ai_test_connection', { settings: config }); setStatus('串流連線測試成功'); }); }}>測試連線</button>
      </fieldset></form></details>
    {!transport && ready && <p role="alert">找不到系統 curl，請先安裝後重新開啟面板。</p>}
    {!root && <p>請先開啟工作區。</p>}
    <div className="ai-messages" aria-label="對話紀錄">{messages.map((message, index) => message.role === 'tool' ? <details key={index}><summary>工具結果</summary><pre>{message.content}</pre></details> : <article key={index}><strong>{message.role === 'user' ? '您' : 'AI'}</strong><pre>{message.content}</pre>{message.tool_calls && <details><summary>工具請求</summary><pre>{JSON.stringify(message.tool_calls, null, 2)}</pre></details>}</article>)}
      {partial && <article><strong>AI（{task ? '回應中' : '回應未完成'}）</strong><pre>{partial}</pre></article>}
    </div>
    <details><summary>本次工具與任務紀錄（{records.length}）</summary>{records.map((record, index) => <details key={index}><summary>{record.kind}</summary><pre>{JSON.stringify(record.detail, null, 2)}</pre></details>)}</details>
    {approval && <section className="ai-approval" role="region" aria-label="待確認操作"><strong>操作確認：{approval.operation.name}</strong>
      {approval.operation.preview.command && <pre>{approval.operation.preview.command}</pre>}
      {approval.operation.preview.changes?.map((change, index) => <div key={index}><span>{change.action} {change.path}</span><button onClick={() => compare(change)}>檢視差異</button></div>)}
      <button disabled={saving} onClick={() => { void decide(true); }}>批准本次操作</button><button disabled={saving} onClick={() => { void decide(false); }}>拒絕</button>
    </section>}
    <form onSubmit={event => { event.preventDefault(); void start(); }}><fieldset disabled={!ready || task || saving}>
      <label><input type="checkbox" checked={automatic} onChange={event => { setAutomatic(event.target.checked); setAuthorize(false); }} />自動模式（本次任務）</label>
      {automatic && <label className="ai-authorization"><input type="checkbox" checked={authorize} onChange={event => setAuthorize(event.target.checked)} />我授權本次任務自動修改檔案與執行任意 shell 命令。命令以我的帳號執行，可存取工作區外檔案與網路。</label>}
      <label><input type="checkbox" checked={attach} onChange={event => setAttach(event.target.checked)} />附加目前選取文字；無選取時附加目前文件（最多 16 KiB）</label>
      <label>開發需求<textarea rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={16384} /></label>
      <button disabled={!root || !transport || automatic && !authorize} type="submit">開始任務</button>
    </fieldset></form>
    <button disabled={!task && !saving} onClick={() => { if (!active.current) { startTicket.current++; void invoke('ai_stop').catch(error => setStatus(String(error))); return; } if (active.current) { setStatus('正在停止…'); void invoke('ai_cancel', { taskId: active.current }).catch(error => setStatus(String(error))); } }}>停止任務</button>
    <button disabled={task || saving || !root} onClick={() => { void action(async () => { await invoke('ai_clear_history', { workspaceRoot: root }); setMessages([]); setRecords([]); const [config, availability] = await Promise.all([invoke<AiSettings>('load_ai_settings'), invoke<{ transport: boolean }>('ai_availability')]); setSettings(config); setTransport(availability.transport); setReady(true); setStatus('對話已清除'); }); }}>清除本機對話</button>
    <p role="status">{status}</p><p>文件工具遵循排除規則；終端命令具備目前使用者的權限。停止任務不會撤銷已完成的修改。</p>
    {comparison && <CompareView {...comparison} english={false} close={() => setComparison(null)} />}
  </aside>;
}
