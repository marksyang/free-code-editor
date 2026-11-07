import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GitHistory } from './GitHistory';
import type { Tab } from './editor-state';
type Entry = { path: string; original: string | null; index: string; worktree: string };
type Status = { branch: string; entries: Entry[] };
export function GitPanel({ root, english, compare, open }: {
  root: string; english: boolean; compare: (left: Tab, right: Tab) => void; open: (path: string) => void;
}) {
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const version = useRef(0);
  const label = (zh: string, en: string) => english ? en : zh;
  async function refresh() {
    const request = ++version.current;
    try {
      const result = await invoke<Status>('git_status', { workspaceRoot: root });
      if (alive.current && request === version.current) { setStatus(result); setError(''); }
    } catch (error) { if (alive.current && request === version.current) { setStatus(null); setError(String(error)); } }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { void refresh(); }; window.addEventListener('focus', focus);
    return () => { alive.current = false; version.current++; window.removeEventListener('focus', focus); };
  }, [root]);
  async function action(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); await refresh(); } catch (error) { if (alive.current) setError(String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function diff(entry: Entry, staged: boolean) {
    await action(async () => {
      const result = await invoke<{ before: string; after: string }>('git_diff', { workspaceRoot: root, path: entry.path, original: staged ? entry.original : null, staged });
      if (!alive.current) return;
      const tab = (id: string, text: string): Tab => ({ id, path: entry.path, text, original: text, language: null });
      const before = tab('git-before', result.before); const after = tab('git-after', result.after);
      before.path = `${staged ? 'HEAD' : 'Index'} · ${staged ? entry.original ?? entry.path : entry.path}`;
      after.path = `${staged ? 'Index' : 'Working tree'} · ${entry.path}`;
      compare(before, after);
    });
  }
  function group(staged: boolean) {
    const entries = status?.entries.filter(entry => staged ? ![' ', '?'].includes(entry.index) : entry.worktree !== ' ') ?? [];
    return <section><h3>{staged ? label('已暫存', 'Staged') : label('變更', 'Changes')} ({entries.length})</h3>
      {entries.map(entry => <div key={entry.path} className="git-entry">
        <button className="git-path" title={`${entry.index}${entry.worktree} ${entry.path}`} disabled={busy} onClick={() => { void diff(entry, staged); }}><code>{staged ? entry.index : entry.worktree}</code> {entry.path}</button>
        <button disabled={busy} title={label('開啟檔案', 'Open file')} onClick={() => open(entry.path)}>↗</button>
        <button disabled={busy} title={staged ? label('取消暫存', 'Unstage') : label('暫存', 'Stage')} onClick={() => { void action(() => invoke('git_stage', { workspaceRoot: root, path: entry.path, undo: staged, original: staged || entry.worktree === 'R' ? entry.original : null })); }}>{staged ? '−' : '+'}</button>
      </div>)}
    </section>;
  }
  return <div className="git-panel">
    <div className="dev-toolbar"><strong>Git {status?.branch}</strong><button disabled={busy} onClick={() => { void refresh(); setHistoryRefresh(value => value + 1); }}>{label('重新整理', 'Refresh')}</button></div>
    {error && <p role="alert" className="dev-error">{error}</p>}
    <div className="sidebar-tabs git-view-tabs"><button className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}>{label('變更', 'Changes')}</button>
      <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>{label('歷史', 'History')}</button></div>
    {view === 'history' ? <GitHistory key={root} root={root} english={english} refreshToken={historyRefresh} compare={compare} /> : status && <><textarea aria-label={label('提交訊息', 'Commit message')} placeholder={label('提交訊息', 'Commit message')} value={message} onChange={event => setMessage(event.target.value)} />
      <button disabled={busy || !message.trim() || !status.entries.some(entry => ![' ', '?'].includes(entry.index))} onClick={() => { void action(async () => { await invoke('git_commit', { workspaceRoot: root, message }); if (alive.current) setMessage(''); }); }}>{label('提交已暫存變更', 'Commit staged changes')}</button>
      <small>{label('Git 使用磁碟版本；請先儲存編輯。點選檔名檢視差異。', 'Git uses disk contents; save edits first. Click a file to view its diff.')}</small>
      {group(true)}{group(false)}
    </>}
  </div>;
}
