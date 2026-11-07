import { useEffect, useRef, useState } from 'react';
import { monaco } from './monaco';
import { languageForPath } from './languages';
import type { Tab } from './editor-state';

type Props = { left: Tab; right: Tab; english: boolean; close: () => void };

/** Own independent models so closing a comparison never disposes editor buffers. */
export function CompareView({ left, right, english, close }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [swapped, setSwapped] = useState(false);
  const original = swapped ? right : left;
  const modified = swapped ? left : right;
  const name = (tab: Tab) => tab.path || (english ? 'Untitled' : '未命名');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const a = monaco.editor.createModel(original.text, original.language ?? languageForPath(original.path));
    const b = monaco.editor.createModel(modified.text, modified.language ?? languageForPath(modified.path));
    const editor = monaco.editor.createDiffEditor(host.current!, {
      theme: 'vs-dark', automaticLayout: true, readOnly: true, originalEditable: false,
      renderSideBySide: true, enableSplitViewResizing: true, minimap: { enabled: false },
    });
    editor.setModel({ original: a, modified: b });
    return () => { editor.dispose(); a.dispose(); b.dispose(); };
  }, [original, modified]);
  return <div className="compare-backdrop">
    <div ref={panel} className="compare-panel" role="dialog" aria-modal="true" aria-label={english ? 'Compare files' : '檔案比較'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          const buttons = panel.current!.querySelectorAll<HTMLButtonElement>('button');
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
          else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); }
        }
      }}>
      <div className="compare-toolbar"><strong>{english ? 'Compare files (read only)' : '檔案比較（唯讀）'}</strong>
        <button onClick={() => setSwapped(value => !value)}>{english ? 'Swap sides' : '交換左右'}</button>
        <button onClick={close}>{english ? 'Close' : '關閉'}</button></div>
      <div className="compare-labels"><span title={name(original)}>{name(original)}</span><span title={name(modified)}>{name(modified)}</span></div>
      <div ref={host} className="compare-editor" />
    </div>
  </div>;
}
