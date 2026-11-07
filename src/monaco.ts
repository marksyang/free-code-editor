import * as monaco from 'monaco-editor';
import { bitbakeLanguage, puppetLanguage, extraLanguageConfiguration, jsonDiagnosticsOptions } from './extra-languages';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

type MonacoHost = typeof globalThis & {
  MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
};
(globalThis as MonacoHost).MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
  jsx: monaco.languages.typescript.JsxEmit.Preserve,
});

monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  ...monaco.languages.json.jsonDefaults.diagnosticsOptions,
  ...jsonDiagnosticsOptions,
});

monaco.languages.register({ id: 'puppet', extensions: ['.pp'], aliases: ['Puppet'] });
monaco.languages.setMonarchTokensProvider('puppet', puppetLanguage);
monaco.languages.setLanguageConfiguration('puppet', {
  ...extraLanguageConfiguration, comments: { lineComment: '#', blockComment: ['/*', '*/'] },
});
monaco.languages.register({ id: 'bitbake', extensions: ['.bb', '.bbappend', '.bbclass'], aliases: ['BitBake', 'Yocto'] });
monaco.languages.setMonarchTokensProvider('bitbake', bitbakeLanguage);
monaco.languages.setLanguageConfiguration('bitbake', extraLanguageConfiguration);

monaco.languages.register({ id: 'makefile' });
monaco.languages.setMonarchTokensProvider('makefile', {
  tokenizer: {
    root: [
      [/^\t.*$/, 'string'],
      [/#.*$/, 'comment'],
      [/\$\([^)]+\)|\$\{[^}]+\}|\$[@%<?^+*|]/, 'variable'],
      [/^\s*(?:-?include|ifdef|ifndef|ifeq|ifneq|else|endif|define|endef|export|unexport|override|private|vpath)\b/, 'keyword'],
      [/^[^\s:#=]+(?=\s*:)/, 'type.identifier'],
      [/[A-Za-z_][\w.-]*(?=\s*(?:[?:+!]?=))/, 'variable'],
      [/[?:+!]?=|::?|%/, 'operator'],
    ],
  },
});
monaco.languages.setLanguageConfiguration('makefile', {
  comments: { lineComment: '#' },
  brackets: [['(', ')'], ['{', '}']],
});

export { monaco };
