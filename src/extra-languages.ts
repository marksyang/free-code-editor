import type { languages } from 'monaco-editor';

export const puppetLanguage: languages.IMonarchLanguage = {
  defaultToken: '', tokenPostfix: '.puppet',
  keywords: ['class', 'define', 'inherits', 'node', 'if', 'elsif', 'else', 'unless', 'case', 'default', 'and', 'or', 'in', 'not', 'true', 'false', 'undef', 'include', 'contain', 'require', 'realize', 'import', 'function', 'type', 'application', 'site', 'plan', 'private', 'tag', 'with'],
  tokenizer: {
    root: [
      [/#.*$/, 'comment'], [/\/\*/, 'comment', '@comment'],
      [/\$(?:(?:::)?[a-z_][\w]*(?:::[\w]+)*|\d+)/i, 'variable'],
      [/"/, 'string', '@doubleString'], [/'/, 'string', '@singleString'],
      [/\/(?:[^/\\]|\\.)+\/[imx]*/, 'regexp'],
      [/[A-Z][\w]*(?:::[\w]+)*/, 'type.identifier'],
      [/[a-z_][\w]*(?:::[\w]+)*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/, 'number'],
      [/<<\||\|>>|<\||\|>|=>|\+>|~>|->|==|!=|<=|>=|=~|!~|[=+*/%!?<>-]/, 'operator'],
      [/[{}()[\]]/, '@brackets'], [/[,:;.]/, 'delimiter'], [/\s+/, 'white'],
    ],
    comment: [[/[^/*]+/, 'comment'], [/\/\*/, 'comment', '@push'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
    doubleString: [
      [/\$\{/, 'variable', '@interpolation'], [/\$(?:(?:::)?[\w]+(?:::[\w]+)*)/, 'variable'],
      [/[^"\\$]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string', '@pop'], [/[$\\]/, 'string'],
    ],
    singleString: [[/[^'\\]+/, 'string'], [/\\./, 'string.escape'], [/'/, 'string', '@pop'], [/\\/, 'string']],
    interpolation: [[/[^{}]+/, 'variable'], [/\{/, 'variable', '@push'], [/\}/, 'variable', '@pop']],
  },
};

export const bitbakeLanguage: languages.IMonarchLanguage = {
  defaultToken: '', tokenPostfix: '.bitbake',
  keywords: ['include', 'require', 'inherit', 'inherit_defer', 'export', 'unset', 'addtask', 'deltask', 'addhandler', 'EXPORT_FUNCTIONS', 'before', 'after', 'python', 'fakeroot'],
  tokenizer: {
    root: [
      [/^\s*python(?:\s+[A-Za-z_][\w:.-]*)?\s*\(\)\s*\{\s*$/, { token: 'keyword', next: '@pythonFunction', nextEmbedded: 'python' }],
      [/^\s*(?:fakeroot\s+)?[A-Za-z_][\w:.-]*\s*\(\)\s*\{\s*$/, { token: 'keyword', next: '@shellFunction', nextEmbedded: 'shell' }],
      [/#.*$/, 'comment'], [/\$\{/, 'variable', '@interpolation'],
      [/"/, 'string', '@doubleString'], [/'/, 'string', '@singleString'],
      [/[A-Za-z_][\w:.-]*(?:\[[\w.-]+\])?/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=/, 'operator'],
      [/\b\d+(?:\.\d+)?\b/, 'number'], [/\\$/, 'string.escape'],
      [/[{}()[\]]/, '@brackets'], [/[,:;]/, 'delimiter'], [/\s+/, 'white'],
    ],
    doubleString: [[/\$\{/, 'variable', '@interpolation'], [/[^"\\$]+/, 'string'], [/\\(?:.|$)/, 'string.escape'], [/"/, 'string', '@pop'], [/\$/, 'string']],
    singleString: [[/\$\{/, 'variable', '@interpolation'], [/[^'\\$]+/, 'string'], [/\\(?:.|$)/, 'string.escape'], [/'/, 'string', '@pop'], [/\$/, 'string']],
    interpolation: [[/\$\{/, 'variable', '@push'], [/\{/, 'variable', '@push'], [/[^{}$]+/, 'variable'], [/\}/, 'variable', '@pop'], [/\$/, 'variable']],
    pythonFunction: [[/^\}\s*(?:#.*)?$/, { token: 'delimiter.bracket', next: '@pop', nextEmbedded: '@pop' }]],
    shellFunction: [[/^\}\s*(?:#.*)?$/, { token: 'delimiter.bracket', next: '@pop', nextEmbedded: '@pop' }]],
  },
};

export const extraLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] }, { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
};

export const jsonDiagnosticsOptions = {
  validate: true, allowComments: false, comments: 'error', trailingCommas: 'error', enableSchemaRequest: false,
} as const;
