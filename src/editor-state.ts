export type Tab = {
  id: string;
  path: string;
  text: string;
  original: string | null;
  language: string | null;
};
export type Session = {
  version: 1;
  root: string;
  tabs: Tab[];
  active: string;
  secondary: string;
  split: boolean;
  preview: boolean;
  english: boolean;
  sidebar: boolean;
  width: number;
  height: number;
};
export const initialSession: Session = {
  version: 1, root: '', tabs: [], active: '', secondary: '', split: false,
  preview: true, english: false, sidebar: true, width: 1280, height: 850,
};
export const isDirty = (tab: Tab) => tab.original === null || tab.text !== tab.original;
export type Action =
  | { type: 'restore'; session: Session }
  | { type: 'workspace'; root: string }
  | { type: 'open'; tab: Tab; pane?: 'primary' | 'secondary' }
  | { type: 'insert'; tab: Tab }
  | { type: 'focus'; id: string; pane: 'primary' | 'secondary' }
  | { type: 'edit'; id: string; text: string }
  | { type: 'saved'; id: string; text: string; path: string }
  | { type: 'renamed'; id: string; path: string }
  | { type: 'reload'; id: string; text: string }
  | { type: 'language'; id: string; language: string | null }
  | { type: 'close'; id: string }
  | { type: 'setting'; key: 'split' | 'preview' | 'english' | 'sidebar'; value: boolean }
  | { type: 'size'; width: number; height: number };

export function editorReducer(state: Session, action: Action): Session {
  switch (action.type) {
    case 'restore': return action.session;
    case 'workspace': return { ...state, root: action.root, tabs: [], active: '', secondary: '' };
    case 'open': {
      const existing = state.tabs.find(t => t.id === action.tab.id || (t.path && t.path === action.tab.path));
      const id = existing?.id ?? action.tab.id;
      return { ...state, tabs: existing ? state.tabs : [...state.tabs, action.tab],
        [action.pane === 'secondary' ? 'secondary' : 'active']: id };
    }
    case 'insert': return state.tabs.some(t => t.id === action.tab.id || (t.path && t.path === action.tab.path)) ? state : { ...state, tabs: [...state.tabs, action.tab] };
    case 'focus': return { ...state, [action.pane === 'secondary' ? 'secondary' : 'active']: action.id };
    case 'edit': if (state.tabs.find(t => t.id === action.id)?.text === action.text) return state; return { ...state, tabs: state.tabs.map(t => t.id === action.id ? { ...t, text: action.text } : t) };
    case 'saved': return { ...state, tabs: state.tabs.map(t => t.id === action.id
      ? { ...t, path: action.path, original: action.text } : t) };
    case 'renamed': return { ...state, tabs: state.tabs.map(t => t.id === action.id ? { ...t, path: action.path } : t) };
    case 'reload': return { ...state, tabs: state.tabs.map(t => t.id === action.id
      ? { ...t, text: action.text, original: action.text } : t) };
    case 'language': return { ...state, tabs: state.tabs.map(t => t.id === action.id ? { ...t, language: action.language } : t) };
    case 'close': {
      const tabs = state.tabs.filter(t => t.id !== action.id);
      return { ...state, tabs,
        active: state.active === action.id ? tabs[0]?.id ?? '' : state.active,
        secondary: state.secondary === action.id ? tabs.find(t => t.id !== state.active)?.id ?? tabs[0]?.id ?? '' : state.secondary };
    }
    case 'setting': return { ...state, [action.key]: action.value,
      ...(action.key === 'split' && action.value && !state.secondary ? { secondary: state.active } : {}) };
    case 'size': return { ...state, width: action.width, height: action.height };
  }
}

export function normalizeSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<Session>;
  if (s.version !== 1 || typeof s.root !== 'string' || !Array.isArray(s.tabs)) return null;
  const ids = new Set<string>();
  const paths = new Set<string>();
  const tabs = s.tabs.filter((t): t is Tab => {
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.path !== 'string' ||
      typeof t.text !== 'string' || !(t.original === null || typeof t.original === 'string') ||
      !(t.language === null || typeof t.language === 'string') || ids.has(t.id) || (t.path && paths.has(t.path))) return false;
    ids.add(t.id); if (t.path) paths.add(t.path); return true;
  }).slice(0, 100);
  return { ...initialSession, root: s.root, tabs,
    active: tabs.some(t => t.id === s.active) ? s.active! : tabs[0]?.id ?? '',
    secondary: tabs.some(t => t.id === s.secondary) ? s.secondary! : tabs[0]?.id ?? '',
    split: s.split === true, preview: s.preview !== false, english: s.english === true, sidebar: s.sidebar !== false,
    width: typeof s.width === 'number' && Number.isFinite(s.width) ? Math.min(3840, Math.max(640, s.width)) : 1280,
    height: typeof s.height === 'number' && Number.isFinite(s.height) ? Math.min(2160, Math.max(480, s.height)) : 850,
  };
}

export function fuzzyPaths(paths: string[], query: string): string[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return paths.slice(0, 100);
  return paths.map(path => {
    const text = path.toLowerCase();
    let cursor = 0, score = 0, previous = -2;
    for (const letter of needle) {
      const index = text.indexOf(letter, cursor);
      if (index < 0) return null;
      score += index === previous + 1 ? 8 : 0;
      if (index === 0 || '/_.-'.includes(text[index - 1])) score += 5;
      previous = index; cursor = index + 1;
    }
    if (text.split('/').pop()?.startsWith(needle)) score += 30;
    return { path, score: score - text.length / 1000 };
  }).filter((item): item is { path: string; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100).map(item => item.path);
}

export function closeSnapshot(state: Session, discarded: Set<string>): Session {
  return normalizeSession({ ...state, tabs: state.tabs.flatMap(tab => {
    if (!discarded.has(tab.id)) return [tab];
    return tab.original === null ? [] : [{ ...tab, text: tab.original }];
  }) })!;
}

export function recoverTab(tab: Tab, disk: string | null): { tab: Tab; conflict: boolean } {
  if (disk === null) return { tab: { ...tab, original: null }, conflict: true };
  if (!isDirty(tab)) return { tab: { ...tab, text: disk, original: disk }, conflict: false };
  return { tab, conflict: tab.original !== disk };
}
