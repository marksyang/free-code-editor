export type TreeFile = { kind: 'file'; name: string; path: string };
export type TreeDirectory = { kind: 'directory'; name: string; path: string; children: TreeNode[] };
export type TreeNode = TreeFile | TreeDirectory;
export type TreeRow = { node: TreeNode; depth: number };

export function workspaceName(root: string): string {
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || '/';
}

export function buildWorkspaceTree(root: string, files: string[], directories: string[] = []): TreeDirectory {
  const tree: TreeDirectory = { kind: 'directory', name: workspaceName(root), path: '', children: [] };
  const folders = new Map<string, TreeDirectory>([['', tree]]);
  const seen = new Set<string>();
  function partsFor(path: string) {
    const parts = path.split('/');
    return !path || parts.some(part => !part || part === '.' || part === '..') ? [] : parts;
  }
  function folder(parts: string[]): TreeDirectory {
    let parent = tree;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let child = folders.get(path);
      if (!child) { child = { kind: 'directory', name, path, children: [] }; folders.set(path, child); parent.children.push(child); }
      parent = child;
    });
    return parent;
  }
  for (const path of directories) { const parts = partsFor(path); if (parts.length) folder(parts); }
  for (const path of files) {
    const parts = partsFor(path);
    if (!parts.length || seen.has(path) || folders.has(path)) continue;
    seen.add(path);
    const parent = folder(parts.slice(0, -1));
    parent.children.push({ kind: 'file', name: parts.at(-1)!, path });
  }
  function sort(node: TreeDirectory) {
    node.children.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name));
    for (const child of node.children) if (child.kind === 'directory') sort(child);
  }
  sort(tree); return tree;
}

export function filterWorkspaceTree(root: TreeDirectory, query: string): TreeDirectory {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return root;
  function filter(node: TreeNode): TreeNode | null {
    if (node.path.toLocaleLowerCase().includes(needle)) return node;
    if (node.kind === 'file') return null;
    const children = node.children.map(filter).filter((n): n is TreeNode => n !== null);
    return children.length ? { ...node, children } : null;
  }
  return { ...root, children: root.children.map(filter).filter((n): n is TreeNode => n !== null) };
}

export function ancestorDirectories(path: string): string[] {
  const parts = path.split('/');
  return ['', ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))];
}

export function visibleTreeRows(root: TreeDirectory, expanded: (path: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  function visit(node: TreeNode, depth: number) {
    rows.push({ node, depth });
    if (node.kind === 'directory' && expanded(node.path)) node.children.forEach(child => visit(child, depth + 1));
  }
  visit(root, 0); return rows;
}
