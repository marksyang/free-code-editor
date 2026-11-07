export type ListContinuation = { prefix: string; removeEmptyMarker: boolean };

export function continueMarkdownList(line: string, before: string): ListContinuation | null {
  // Only act outside fenced code blocks; otherwise leave Enter to Monaco.
  let fence: string | null = null;
  for (const previous of before.split(/\r?\n/)) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(previous);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(previous)) fence = null;
  }
  if (fence) return null;
  const match = /^(\s*)([-+*]|(\d+)([.)]))\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
  if (!match) return null;
  if (!match[6].trim()) return { prefix: match[1], removeEmptyMarker: true };
  const marker = match[3] ? `${Number(match[3]) + 1}${match[4]}` : match[2];
  return { prefix: `${match[1]}${marker} ${match[5] === undefined ? '' : '[ ] '}`, removeEmptyMarker: false };
}
