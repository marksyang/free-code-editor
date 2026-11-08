import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TextEncoding } from './text-encoding';
import type { Tab } from './editor-state';

type Commit = { hash: string; parents: string[]; author: string; date: string; subject: string };
type History = { commits: Commit[]; head: string | null; has_more: boolean };
type HistoryFile = { path: string; original: string | null; status: string };
type Details = { parent: string | null; files: HistoryFile[] };
export function GitHistory({ root, english, refreshToken, compare, encoding }: {
  root: string; english: boolean; refreshToken: number; encoding: TextEncoding; compare: (left: Tab, right: Tab) => void;
}) {
  const [history, setHistory] = useState<History>({ commits: [], head: null, has_more: false });
  const [selected, setSelected] = useState<Commit | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState('');
  const detailsHost = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const pageVersion = useRef(0);
  const detailVersion = useRef(0);
  const label = (zh: string, en: string) => english ? en : zh;
  async function load(reset: boolean) {
    const request = ++pageVersion.current;
    setLoading(true); setError('');
    if (reset) { detailVersion.current++; setSelected(null); setDetails(null); setDetailsLoading(false); }
    try {
      const page = await invoke<History>('git_history', { workspaceRoot: root, offset: reset ? 0 : history.commits.length, anchor: reset ? null : history.head });
      if (alive.current && request === pageVersion.current) setHistory(previous => ({ ...page, commits: reset ? page.commits : [...previous.commits, ...page.commits] }));
    } catch (error) { if (alive.current && request === pageVersion.current) setError(String(error)); }
    finally { if (alive.current && request === pageVersion.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; void load(true);
    const focus = () => { void load(true); }; window.addEventListener('focus', focus);
    return () => { alive.current = false; pageVersion.current++; detailVersion.current++; window.removeEventListener('focus', focus); };
  }, [root, refreshToken]);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => detailsHost.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected, details]);
  async function select(commit: Commit) {
    const request = ++detailVersion.current;
    setSelected(commit); setDetails(null); setDetailsLoading(true); setError('');
    try {
      const result = await invoke<Details>('git_commit_files', { workspaceRoot: root, revision: commit.hash });
      if (alive.current && request === detailVersion.current) setDetails(result);
    } catch (error) { if (alive.current && request === detailVersion.current) setError(String(error)); }
    finally { if (alive.current && request === detailVersion.current) setDetailsLoading(false); }
  }
  async function diff(file: HistoryFile) {
    if (!selected || !details || comparing) return;
    const commit = selected; const parent = details.parent; const request = detailVersion.current;
    setComparing(true); setError('');
    try {
      const result = await invoke<{ before: string; after: string }>('git_history_diff', { workspaceRoot: root, revision: commit.hash, path: file.path, original: file.original, encoding });
      if (!alive.current || request !== detailVersion.current) return;
      const tab = (id: string, path: string, text: string): Tab => ({ id, path, text, original: text, language: null });
      compare(tab('history-before', `${parent?.slice(0, 8) ?? label('空版本', 'Empty')} · ${file.original ?? file.path}`, result.before),
        tab('history-after', `${commit.hash.slice(0, 8)} · ${file.path}`, result.after));
    } catch (error) { if (alive.current && request === detailVersion.current) setError(String(error)); }
    finally { if (alive.current) setComparing(false); }
  }
  return <section className="git-history" aria-label={label('Git 提交歷史', 'Git history')}>
    {error && <p className="dev-error" role="alert">{error}</p>}
    {loading && <p role="status">{label('載入歷史…', 'Loading history…')}</p>}
    {!loading && !history.commits.length && !error && <p>{label('尚無提交紀錄', 'No commits yet')}</p>}
    <ol className="git-history-list">{history.commits.map(commit => <li key={commit.hash}>
      <button disabled={comparing} className={selected?.hash === commit.hash ? 'active' : ''} aria-pressed={selected?.hash === commit.hash}
        title={commit.hash} onClick={() => { void select(commit); }}>
        <strong>{commit.subject || label('（無訊息）', '(No message)')}</strong>
        <span><code>{commit.hash.slice(0, 8)}</code> · {commit.author}</span>
        <time dateTime={commit.date}>{new Date(commit.date).toLocaleString(english ? 'en' : 'zh-TW')}</time>
      </button>
    </li>)}</ol>
    {history.has_more && <button disabled={loading || comparing} onClick={() => { void load(false); }}>{label('載入更多', 'Load more')}</button>}
    {selected && <section ref={detailsHost} className="git-commit-details" aria-label={label('提交變更', 'Commit changes')}>
      <h3>{label('提交變更', 'Commit changes')} · {selected.hash.slice(0, 8)}</h3>
      {selected.parents.length > 1 && <small>{label('與第一個父提交比較', 'Compared with the first parent')}</small>}
      {detailsLoading && <p role="status">{label('載入檔案…', 'Loading files…')}</p>}
      {details && <><small>{details.files.length} {label('個變更檔案；點選檢視差異', 'changed files; click to compare')}</small>
        {details.files.map(file => <button key={file.path} className="git-history-file" disabled={comparing}
          title={file.original ? `${file.original} → ${file.path}` : file.path} onClick={() => { void diff(file); }}>
          <code>{file.status}</code> {file.original ? `${file.original} → ` : ''}{file.path}
        </button>)}
      </>}
    </section>}
  </section>;
}
