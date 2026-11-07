import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ancestorDirectories, buildWorkspaceTree, filterWorkspaceTree, visibleTreeRows } from './file-tree-model';
import type { TreeNode } from './file-tree-model';

export function ExplorerIcon({ kind, expanded = false }: { kind: 'file' | 'directory'; expanded?: boolean }) {
  return kind === 'directory'
    ? <svg className="explorer-icon folder-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={expanded ? 'M1.5 5V3.5h5l1.5 1.5h6.5v2H4l-2.5 6V5Zm2.8 3h11l-2 5h-11l2-5Z' : 'M1.5 3.5h5L8 5h6.5v8h-13v-9.5Z'} />
    </svg>
    : <svg className="explorer-icon file-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 1.5h6l4 4v9H3V1.5Zm6 0v4h4M5.5 8h5M5.5 10.5h5" />
    </svg>;
}

type DirectoryListing = { files: string[]; directories: string[] };
type DirectoryState = { listing?: DirectoryListing; error?: string };

type Props = {
  root: string;
  files: string[];
  directories: string[];
  activePath: string;
  filter: string;
  english: boolean;
  open: (path: string) => void;
  disabled: boolean;
  findInFolder?: (path: string) => void;
  loadDirectory?: (path: string) => Promise<DirectoryListing>;
};

export function FileTree({ root, files, directories, activePath, filter, english, open, disabled, loadDirectory, findInFolder }: Props) {
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState('');
  const elements = useRef(new Map<string, HTMLLIElement>());
  const [loaded, setLoaded] = useState<Record<string, DirectoryState>>({});
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    generation.current++; pending.current.clear(); setLoaded({});
    return () => { generation.current++; };
  }, [files, directories]);
  const query = filter.trim().toLocaleLowerCase();
  const completeTree = useMemo(() => buildWorkspaceTree(root, [...files, ...Object.values(loaded).flatMap(value => value.listing?.files ?? [])],
    [...directories, ...Object.values(loaded).flatMap(value => value.listing?.directories ?? [])]), [root, files, directories, loaded]);
  const tree = useMemo(() => filterWorkspaceTree(completeTree, query), [completeTree, query]);
  const isExpanded = (path: string) => query ? !filterCollapsed.has(path) : expanded.has(path);
  const rows = visibleTreeRows(tree, isExpanded);
  const focusPath = rows.some(row => row.node.path === focused) ? focused : '';

  useEffect(() => { setFilterCollapsed(new Set()); }, [query]);
  useEffect(() => {
    if (!activePath) return;
    const ancestors = ancestorDirectories(activePath);
    setExpanded(previous => new Set([...previous, ...ancestors]));
    setFilterCollapsed(previous => new Set([...previous].filter(path => !ancestors.includes(path))));
    setFocused(activePath);
    const frame = requestAnimationFrame(() => elements.current.get(activePath)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [root, activePath]);

  useEffect(() => {
    if (!loadDirectory) return;
    for (const path of expanded) {
      if (!path || loaded[path] || pending.current.has(path)) continue;
      const version = generation.current;
      pending.current.add(path);
      void loadDirectory(path).then(listing => {
        if (version === generation.current) setLoaded(previous => ({ ...previous, [path]: { listing } }));
      }, error => {
        if (version === generation.current) setLoaded(previous => ({ ...previous, [path]: { error: String(error) } }));
      }).finally(() => { if (version === generation.current) pending.current.delete(path); });
    }
  }, [expanded, loaded, loadDirectory, files, directories]);

  useEffect(() => {
    if (!activePath) return;
    const frame = requestAnimationFrame(() => elements.current.get(activePath)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [activePath, loaded]);

  useEffect(() => {
    if (!menu) return;
    menuButton.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('[data-folder-menu]')) setMenu(null);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); focus(menu.path); }
      if (event.key === 'Tab') setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  function showFolderMenu(path: string, x: number, y: number) {
    if (disabled || !findInFolder) return;
    setFocused(path);
    setMenu({ path, x: Math.max(0, Math.min(x, window.innerWidth - 220)), y: Math.max(0, Math.min(y, window.innerHeight - 60)) });
  }

  function focus(path: string) {
    setFocused(path); elements.current.get(path)?.focus({ preventScroll: true });
  }
  function setOpen(path: string, value: boolean) {
    if (value) setExpanded(previous => new Set([...previous, path]));
    if (value && loaded[path]?.error) setLoaded(previous => { const next = { ...previous }; delete next[path]; return next; });
    if (query) setFilterCollapsed(previous => { const next = new Set(previous); if (value) next.delete(path); else next.add(path); return next; });
    else setExpanded(previous => { const next = new Set(previous); if (value) next.add(path); else next.delete(path); return next; });
  }
  function activate(node: TreeNode) {
    if (disabled) return;
    if (node.kind === 'directory') setOpen(node.path, !isExpanded(node.path));
    else open(node.path);
  }
  function keyboard(event: KeyboardEvent<HTMLUListElement>) {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const path = item?.dataset.path;
    const index = rows.findIndex(row => row.node.path === path);
    if (index < 0) return;
    const node = rows[index].node;
    switch (event.key) {
      case 'ArrowDown': focus(rows[Math.min(rows.length - 1, index + 1)].node.path); break;
      case 'ArrowUp': focus(rows[Math.max(0, index - 1)].node.path); break;
      case 'Home': focus(rows[0].node.path); break;
      case 'End': focus(rows.at(-1)!.node.path); break;
      case 'ArrowRight':
        if (node.kind === 'directory') {
          if (!isExpanded(path!)) setOpen(path!, true);
          else if (node.children.length) focus(node.children[0].path);
        }
        break;
      case 'ArrowLeft':
        if (node.kind === 'directory' && isExpanded(path!)) setOpen(path!, false);
        else if (path) focus(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
        break;
      case 'Enter': case ' ': activate(node); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
  }

  const thisDirectoryExpanded = (path: string) => expanded.has(path);

  function render(node: TreeNode, depth: number) {
    const directory = node.kind === 'directory';
    const expanded = directory && isExpanded(node.path);
    const selected = !directory && node.path === activePath;
    return <li key={node.path} role="treeitem" aria-label={node.name} aria-level={depth + 1}
      aria-expanded={directory ? expanded : undefined} aria-selected={directory ? undefined : selected}
      aria-disabled={disabled || undefined} data-path={node.path} data-kind={node.kind}
      tabIndex={focusPath === node.path ? 0 : -1} className={`tree-node${selected ? ' is-selected' : ''}`}
      ref={element => { if (element) elements.current.set(node.path, element); else elements.current.delete(node.path); }}
      onKeyDown={event => {
        if (event.target === event.currentTarget && directory && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault(); event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect(); showFolderMenu(node.path, rect.left + 24, rect.top + 24);
        }
      }}
      onFocus={event => { if (event.target === event.currentTarget) setFocused(node.path); }}>
      <div className={`tree-row${depth === 0 ? ' tree-root' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}
        title={node.path ? `${root.replace(/\/$/, '')}/${node.path}` : root}
        onContextMenu={event => { if (directory && findInFolder && !disabled) {
          event.preventDefault(); event.stopPropagation(); showFolderMenu(node.path, event.clientX, event.clientY);
        } }}
        onClick={() => { if (!disabled) { focus(node.path); activate(node); } }}>
        <span className={`tree-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true">
          {directory && <svg viewBox="0 0 10 10"><path d="m3 1.5 4 3.5-4 3.5" /></svg>}
        </span>
        <ExplorerIcon kind={node.kind} expanded={expanded} />
        <span className="tree-label">{node.name}</span>
      </div>
      {directory && expanded && node.path && loadDirectory && !loaded[node.path] && !thisDirectoryExpanded(node.path) && <button onClick={() => setOpen(node.path, true)}>{english ? 'Load folder contents' : '載入資料夾內容'}</button>}
      {directory && expanded && node.path && loadDirectory && !loaded[node.path] && thisDirectoryExpanded(node.path) && <span className="explorer-empty" role="status">{english ? 'Loading…' : '載入中…'}</span>}
      {directory && expanded && loaded[node.path]?.error && <button onClick={() => setOpen(node.path, true)} title={loaded[node.path].error}>{english ? 'Unable to load — retry' : '載入失敗，點此重試'}</button>}
      {directory && expanded && node.children.length > 0 && <ul role="group">{node.children.map(child => render(child, depth + 1))}</ul>}
    </li>;
  }

  if (!root) return <p className="explorer-empty">{english ? 'No folder opened' : '尚未開啟資料夾'}</p>;
  return <div className="file-tree">
    {menu && <div role="menu" data-folder-menu className="folder-context-menu" style={{ left: menu.x, top: menu.y }}
      aria-label={english ? 'Folder actions' : '資料夾操作'}>
      <button ref={menuButton} role="menuitem" onClick={() => { findInFolder?.(menu.path); setMenu(null); }}>
        {english ? 'Find in Folder…' : '在資料夾中搜尋…'}
      </button>
    </div>}
    <ul role="tree" aria-label={english ? 'Workspace folders' : '工作區資料夾'} onKeyDown={keyboard}>{render(tree, 0)}</ul>
    {tree.children.length === 0 && isExpanded('') && <p className="explorer-empty">{query
      ? english ? 'No matching files or folders' : '找不到符合的檔案或資料夾'
      : english ? 'No visible files or folders' : '此資料夾沒有可顯示的項目'}</p>}
  </div>;
}
