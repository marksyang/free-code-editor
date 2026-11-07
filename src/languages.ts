export const languageIds = [
  'plaintext', 'c', 'cpp', 'rust', 'javascript', 'typescript', 'json', 'python',
  'perl', 'shell', 'css', 'html', 'makefile', 'markdown', 'puppet', 'pascal', 'bitbake',
] as const;

export const lspLanguages = ['c', 'cpp', 'rust', 'javascript', 'typescript', 'json', 'python', 'perl', 'shell', 'css', 'html'] as const;

const extensions: Record<string, string> = {
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp',
  hh: 'cpp', hpp: 'cpp', hxx: 'cpp', rs: 'rust',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', py: 'python', pl: 'perl', pm: 'perl', t: 'perl', psgi: 'perl',
  sh: 'shell', bash: 'shell', css: 'css', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', mk: 'makefile', pp: 'puppet',
  pas: 'pascal', p: 'pascal', bb: 'bitbake', bbappend: 'bitbake', bbclass: 'bitbake',
};

export function languageForPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').pop() ?? '';
  if (['Makefile', 'makefile', 'GNUmakefile'].includes(name)) return 'makefile';
  const lower = normalized.toLowerCase();
  // .inc and .conf are shared by many languages; use BitBake only for recognizable Yocto paths.
  if (/(?:^|\/)bitbake\.conf$/.test(lower) || /(?:^|\/)conf\/(?:layer|local|bblayers)\.conf$/.test(lower) ||
      /(?:^|\/)conf\/(?:machine|distro|multiconfig)\/.*\.conf$/.test(lower) ||
      /(?:^|\/)(?:recipes-[^/]+|classes(?:-global|-recipe)?|conf\/(?:machine|distro|multiconfig))\/.*\.inc$/.test(lower)) return 'bitbake';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? 'plaintext' : extensions[name.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}

export function languageForCodeFence(language: string): string {
  const id = language.trim().toLowerCase();
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', tsx: 'typescript', pas: 'pascal', sh: 'shell', bash: 'shell', py: 'python', rs: 'rust', pl: 'perl', pm: 'perl', pp: extensions.pp, bb: 'bitbake', 'c++': 'cpp', make: 'makefile' };
  return aliases[id] ?? (languageIds.some(language => language === id) ? id : 'plaintext');
}

// The TypeScript worker uses the model URI suffix to distinguish TS from TSX/declarations.
export function editorModelPath(root: string, id: string, path: string, language: string | null): string {
  const mode = language ?? languageForPath(path);
  const lower = path.toLowerCase();
  const suffix = mode !== 'typescript' ? '' : lower.endsWith('.tsx') ? '.tsx' : lower.endsWith('.d.ts') ? '.d.ts' : '.ts';
  // Keep the workspace root opaque after URI parsing; decoded slashes otherwise break TypeScript path normalization.
  return `editor://workspace/${encodeURIComponent(encodeURIComponent(root))}/${encodeURIComponent(id)}${suffix}`;
}
