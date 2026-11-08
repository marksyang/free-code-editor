import type { TextEncoding } from './editor-state';
export type { TextEncoding } from './editor-state';
export type TextDocument = { text: string; encoding: TextEncoding };
export const encodingChoices: { id: TextEncoding; label: string }[] = [
  { id: 'utf8', label: 'UTF-8' }, { id: 'big5', label: 'Big5 / CP950' },
  { id: 'gbk', label: 'GBK / CP936 (GB2312)' }, { id: 'gb18030', label: 'GB18030' },
];
