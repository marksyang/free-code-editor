import type { Tab } from './editor-state';

/** Capture buffers before asynchronous disk reads; comparisons never modify editor state. */
export async function comparisonForPath(source: Tab, path: string, tabs: Tab[], read: (path: string) => Promise<string>) {
  const left = { ...source };
  const opened = tabs.find(tab => tab.path === path);
  if (opened) return { left, right: { ...opened } };
  const text = await read(path);
  return { left, right: { id: `comparison:${path}`, path, text, original: text, language: null } satisfies Tab };
}
