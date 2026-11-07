import { useState } from 'react';
import type { LspSettings as Settings } from './lsp-protocol';

const instructions: Record<string, string> = {
  cpp: 'clangd — C / C++；可設定 --compile-commands-dir=…',
  javascript: 'npm install -g typescript-language-server typescript@6',
  rust: 'rustup component add rust-analyzer rust-src',
  json: 'npm install -g vscode-langservers-extracted',
  perl: 'npm install -g perlnavigator-server（另需 Perl 執行環境）',
  python: 'npm install -g pyright',
  shell: 'npm install -g bash-language-server',
  css: 'npm install -g vscode-langservers-extracted',
  html: 'npm install -g vscode-langservers-extracted',
};
export function LspSettings({ settings, english, status, save, close }: {
  settings: Settings; english: boolean; status: Record<string, string>;
  save: (settings: Settings) => Promise<void>; close: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [key, setKey] = useState('cpp');
  const [args, setArgs] = useState(JSON.stringify(settings.servers.cpp?.args ?? [], null, 2));
  const [env, setEnv] = useState(JSON.stringify(settings.servers.cpp?.env ?? {}, null, 2));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const label = (zh: string, en: string) => english ? en : zh;
  function parse() {
    const a: unknown = JSON.parse(args), e: unknown = JSON.parse(env);
    if (!Array.isArray(a) || !a.every(v => typeof v === 'string') || !e || typeof e !== 'object' || Array.isArray(e) || !Object.values(e).every(v => typeof v === 'string')) {
      throw new Error(label('參數須為字串陣列，環境變數須為字串物件。', 'Arguments must be a string array; environment must be a string-valued object.'));
    }
    return { ...draft, servers: { ...draft.servers, [key]: { ...draft.servers[key], args: a as string[], env: e as Record<string, string> } } };
  }
  return <div className="overlay"><form className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="lsp-title" onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); close(); } }}
    onSubmit={event => { event.preventDefault(); setError(''); let next: Settings; try { next = parse(); } catch (e) { setError(String(e)); return; }
      setSaving(true); void save(next).then(close).catch(e => setError(String(e))).finally(() => setSaving(false)); }}>
    <h2 id="lsp-title">{label('語言智慧功能設定', 'Language service settings')}</h2>
    <label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />{label('啟用 LSP', 'Enable LSP')}</label>
    <div className="settings-row"><label>{label('語言', 'Language')}<select value={key} onChange={e => {
      try {
        const next = parse(); setDraft(next); setKey(e.target.value);
        setArgs(JSON.stringify(next.servers[e.target.value].args, null, 2)); setEnv(JSON.stringify(next.servers[e.target.value].env, null, 2)); setError('');
      } catch (error) { setError(String(error)); }
    }}>{Object.keys(draft.servers).map(k => <option key={k} value={k}>{k === 'cpp' ? 'C / C++' : k === 'javascript' ? 'JavaScript / TypeScript' : k}</option>)}</select></label>
    <label><input type="checkbox" checked={draft.servers[key].enabled} onChange={e => setDraft({ ...draft, servers: { ...draft.servers, [key]: { ...draft.servers[key], enabled: e.target.checked } } })} />{label('啟用此伺服器', 'Enable server')}</label></div>
    <label>{label('執行檔（可使用絕對路徑）', 'Executable (absolute paths supported)')}<input autoFocus value={draft.servers[key].executable} required
      onChange={e => setDraft({ ...draft, servers: { ...draft.servers, [key]: { ...draft.servers[key], executable: e.target.value } } })} /></label>
    <label>{label('參數（JSON 字串陣列，不經 shell 展開）', 'Arguments (JSON string array; no shell expansion)')}<textarea value={args} rows={3} onChange={e => setArgs(e.target.value)} /></label>
    <label>{label('環境變數（JSON 物件，以明文儲存）', 'Environment (JSON object; stored as plaintext)')}<textarea value={env} rows={3} onChange={e => setEnv(e.target.value)} /></label>
    <p className="install-hint">{instructions[key]}</p><p>{label('狀態', 'Status')}: {status[key] ?? label('尚未啟動', 'Not started')}</p>
    <p>{label('儲存後重新啟動語言服務。需自行安裝伺服器；編輯器不會執行上述安裝指令。', 'Saving restarts language services. Install servers separately; the editor does not run these install commands.')}</p>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={saving} type="submit">{label('儲存並重啟', 'Save and restart')}</button><button disabled={saving} type="button" onClick={close}>{label('取消', 'Cancel')}</button></div>
  </form></div>;
}
