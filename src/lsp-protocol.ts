export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type TextEdit = { range: Range; newText: string };
export type EditGroup = { uri: string; version: number | null; edits: TextEdit[] };
export type ServerConfig = { enabled: boolean; executable: string; args: string[]; env: Record<string, string> };
export type LspSettings = { enabled: boolean; servers: Record<string, ServerConfig> };
export const serverKey = (language: string) => language === 'c' ? 'cpp' : language === 'typescript' ? 'javascript' : ['cpp', 'rust', 'javascript', 'json', 'python', 'perl', 'shell', 'css', 'html'].includes(language) ? language : null;
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function position(value: unknown): Position | null {
  const p = object(value);
  return p && typeof p.line === 'number' && Number.isSafeInteger(p.line) && p.line >= 0 && typeof p.character === 'number' && Number.isSafeInteger(p.character) && p.character >= 0
    ? { line: p.line, character: p.character } : null;
}
export function range(value: unknown): Range | null {
  const r = object(value), start = position(r?.start), end = position(r?.end);
  return start && end && (start.line < end.line || (start.line === end.line && start.character <= end.character)) ? { start, end } : null;
}
export function textEdit(value: unknown): TextEdit | null {
  const edit = object(value), r = range(edit?.range);
  return r && typeof edit?.newText === 'string' ? { range: r, newText: edit.newText } : null;
}
export function markdown(value: unknown): { value: string; isTrusted: false; supportHtml: false }[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => {
    if (typeof item === 'string') return [{ value: item, isTrusted: false as const, supportHtml: false as const }];
    const entry = object(item);
    if (typeof entry?.value !== 'string') return [];
    const plain = entry.kind === 'plaintext';
    const language = typeof entry.language === 'string' ? entry.language.replace(/[^\w+-]/g, '') : '';
    const value = language ? `\`\`\`${language}\n${entry.value.replaceAll('```', '\\`\\`\\`')}\n\`\`\``
      : plain ? entry.value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&') : entry.value;
    return [{ value, isTrusted: false as const, supportHtml: false as const }];
  });
}
export function workspaceEdits(value: unknown): EditGroup[] {
  const edit = object(value);
  if (!edit) throw new Error('No rename edits returned');
  const groups: EditGroup[] = [];
  const changes = object(edit.changes);
  if (Array.isArray(edit.documentChanges)) {
    if (changes && Object.keys(changes).length) throw new Error('Ambiguous workspace edit');
    for (const value of edit.documentChanges) {
      const change = object(value), document = object(change?.textDocument);
      if (!document || typeof document.uri !== 'string' || !Array.isArray(change?.edits)) throw new Error('Rename file operations are not supported');
      const edits = change.edits.map(textEdit);
      if (edits.some(e => !e)) throw new Error('Invalid rename text edit');
      const version = document.version;
      if (!(version === undefined || version === null || (typeof version === 'number' && Number.isSafeInteger(version)))) throw new Error('Invalid rename document version');
      groups.push({ uri: document.uri, version: typeof version === 'number' ? version : null, edits: edits as TextEdit[] });
    }
  } else if (changes) {
    for (const [uri, values] of Object.entries(changes)) {
      if (!Array.isArray(values)) throw new Error('Invalid rename text edits');
      const edits = values.map(textEdit);
      if (edits.some(e => !e)) throw new Error('Invalid rename text edit');
      groups.push({ uri, version: null, edits: edits as TextEdit[] });
    }
  }
  if (groups.length > 50 || groups.some(g => g.edits.length > 10_000) || new Set(groups.map(g => g.uri)).size !== groups.length) throw new Error('Unsupported or oversized workspace edit');
  return groups;
}
export function validateEdits(text: string, edits: TextEdit[]): void {
  const lines = text.split('\n');
  const starts: number[] = []; let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  function index(p: Position) {
    const line = lines[p.line];
    const length = line?.endsWith('\r') ? line.length - 1 : line?.length;
    if (line === undefined || p.character > length!) throw new Error('Rename range is outside the document');
    const at = starts[p.line] + p.character;
    if (at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] ?? '')) throw new Error('Rename splits a Unicode surrogate pair');
    return at;
  }
  const intervals = edits.map(edit => ({ start: index(edit.range.start), end: index(edit.range.end) })).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end || intervals[i].start === intervals[i - 1].start) throw new Error('Overlapping rename edits');
  }
}
