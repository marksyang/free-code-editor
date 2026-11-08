import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let localFont: Promise<boolean> | undefined;
function loadLocalFont() {
  return localFont ??= invoke<ArrayBuffer>('terminal_font').then(async bytes => {
    if (!bytes.byteLength) return false;
    const font = await new FontFace('Free Code Terminal Nerd Font', bytes).load();
    document.fonts.add(font);
    return true;
  }).catch(() => false);
}

type Poll = { bytes: number[]; exited: boolean; truncated: boolean; exitCode?: number | null };
export function TerminalPanel({ root, english, visible, hide }: { root: string; english: boolean; visible: boolean; hide: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [generation, restart] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!root || !host.current) return;
    let disposed = false;
    let id: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let writes = Promise.resolve();
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000,
      // Shell themes use private-use glyphs absent from the default monospace font.
      fontFamily: '"SauceCodePro Nerd Font Mono", "SauceCodePro Nerd Font", "MesloLGS NF", "MesloLGM Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Hack Nerd Font Mono", "Symbols Nerd Font Mono", Menlo, Monaco, monospace',
      rescaleOverlappingGlyphs: true,
      theme: { background: '#17191f' },
    });
    const addon = new FitAddon();
    term.loadAddon(addon); term.open(host.current); addon.fit();
    terminal.current = term; fit.current = addon; setError('');
    const report = (error: unknown) => { if (!disposed) setError(String(error)); };
    const input = term.onData(data => {
      if (id === null || disposed) return;
      const session = id;
      writes = writes.then(() => invoke<void>('terminal_write', { id: session, data })).catch(report);
    });
    const resize = term.onResize(size => { if (id !== null) void invoke('terminal_resize', { id, columns: size.cols, rows: size.rows }).catch(report); });
    const observer = new ResizeObserver(() => { if (host.current?.offsetHeight) addon.fit(); });
    observer.observe(host.current);
    const refreshFonts = () => {
      if (disposed) return;
      if (host.current?.offsetHeight) addon.fit();
      term.refresh(0, term.rows - 1);
    };
    // Recalculate cell metrics when WebView finishes resolving local fonts.
    void document.fonts.ready.then(refreshFonts);
    document.fonts.addEventListener('loadingdone', refreshFonts);
    async function poll() {
      if (disposed || id === null) return;
      try {
        const output = await invoke<Poll>('terminal_poll', { id });
        if (disposed) return;
        if (output.truncated) term.writeln('\r\n[Output buffer overflow: older output was dropped]');
        if (output.bytes.length) term.write(new Uint8Array(output.bytes));
        if (output.exited) {
          const code = output.exitCode == null ? '' : ` (code ${output.exitCode})`;
          term.writeln(`\r\n[Shell exited${code} — restart to continue]`);
          return;
        }
        timer = setTimeout(() => { void poll(); }, 50);
      } catch (error) { report(error); }
    }
    void loadLocalFont().then(async loaded => {
      if (disposed) return null;
      if (loaded) term.options.fontFamily = `"Free Code Terminal Nerd Font", ${term.options.fontFamily}`;
      refreshFonts();
      return invoke<number>('terminal_start', { workspaceRoot: root, columns: term.cols, rows: term.rows });
    }).then(session => {
      if (session === null) return;
      if (disposed) { void invoke('terminal_stop', { id: session }).catch(() => {}); return; }
      id = session; term.focus(); void poll();
    }).catch(report);
    return () => {
      disposed = true; clearTimeout(timer); observer.disconnect(); document.fonts.removeEventListener('loadingdone', refreshFonts); input.dispose(); resize.dispose();
      term.dispose(); terminal.current = null; fit.current = null;
      if (id !== null) void invoke('terminal_stop', { id }).catch(() => {});
    };
  }, [root, generation]);
  useEffect(() => { if (visible) { const frame = requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); }); return () => cancelAnimationFrame(frame); } }, [visible]);
  return <section className="terminal-panel" hidden={!visible} aria-label={english ? 'Terminal' : '終端機'}>
    <div className="dev-toolbar"><strong>{english ? 'Terminal' : '終端機'}</strong><span title={root}>{root}</span>
      <button onClick={() => terminal.current?.clear()}>{english ? 'Clear' : '清除'}</button>
      <button onClick={() => restart(value => value + 1)}>{english ? 'Restart' : '重新啟動'}</button>
      <button onClick={hide} aria-label={english ? 'Hide terminal' : '隱藏終端機'}>×</button></div>
    {error && <p role="alert" className="dev-error">{error}</p>}
    <div ref={host} className="terminal-host" />
  </section>;
}
