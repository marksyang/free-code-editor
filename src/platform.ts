export function normalizeUserPath(path: string, windows: boolean): string {
  if (!windows) return path;
  let normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('//?/UNC/')) normalized = `//${normalized.slice(8)}`;
  else if (normalized.startsWith('//?/')) normalized = normalized.slice(4);
  return normalized;
}
export function absoluteFileLocation(path: string, windows: boolean): { directory: string; name: string } | null {
  const normalized = normalizeUserPath(path, windows);
  const absolute = windows ? /^[a-z]:\//i.test(normalized) || /^\/\/[^/]+\/[^/]+\/.+/.test(normalized) : normalized.startsWith('/');
  if (!absolute || normalized.endsWith('/')) return null;
  const slash = normalized.lastIndexOf('/');
  let directory = normalized.slice(0, slash) || '/';
  if (windows && /^[a-z]:$/i.test(directory)) directory += '/';
  return { directory, name: normalized.slice(slash + 1) };
}
export function shortcutLabel(value: string, mac: boolean): string {
  return mac ? value : value.replaceAll('⌘', 'Ctrl+').replaceAll('⇧', 'Shift+');
}
