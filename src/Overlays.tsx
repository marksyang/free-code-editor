import { useEffect, useRef, useState } from 'react';

export type DialogSpec = { title: string; message?: string; input?: string; placeholder?: string; choices: { id: string; label: string }[] };
export type DialogResult = { choice: string; value: string };
export function Dialog({ spec, done }: { spec: DialogSpec; done: (result: DialogResult) => void }) {
  const [value, setValue] = useState(spec.input ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <div className="overlay" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); done({ choice: 'cancel', value }); } }}>
    <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"
      onSubmit={e => { e.preventDefault(); done({ choice: spec.choices[0].id, value }); }}>
      <h2 id="dialog-title">{spec.title}</h2>
      {spec.message && <p>{spec.message}</p>}
      {spec.input !== undefined && <input ref={ref} aria-label={spec.title} value={value} placeholder={spec.placeholder} onChange={e => setValue(e.target.value)} required />}
      <div className="dialog-actions">{spec.choices.map((c, i) => <button key={c.id} type={i === 0 ? 'submit' : 'button'}
        autoFocus={spec.input === undefined && i === 0} onClick={i === 0 ? undefined : () => done({ choice: c.id, value })}>{c.label}</button>)}</div>
    </form>
  </div>;
}

export type PaletteEntry = { id: string; title: string; detail?: string; run: () => void };
export function Palette({ title, query, change, entries, close }: {
  title: string; query: string; change: (query: string) => void; entries: PaletteEntry[]; close: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => { list.current?.children[selected]?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  function activate(index: number) { const entry = entries[index]; if (entry) { close(); requestAnimationFrame(entry.run); } }
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label={title}>
      <input autoFocus value={query} aria-label={title} placeholder={title} onChange={e => change(e.target.value)} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, entries.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)); }
        if (e.key === 'Enter') { e.preventDefault(); activate(Math.max(0, selected)); }
      }} />
      <div className="palette-list" ref={list}>{entries.map((entry, i) => <button key={entry.id} className={i === selected ? 'selected' : ''}
        onMouseEnter={() => setSelected(i)} onClick={() => activate(i)}><span>{entry.title}</span><small>{entry.detail}</small></button>)}</div>
    </div>
  </div>;
}
