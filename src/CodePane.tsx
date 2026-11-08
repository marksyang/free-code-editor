import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { monaco } from './monaco';
import { languageForPath, editorModelPath } from './languages';
import { continueMarkdownList } from './markdown-edit';
import type { Tab } from './editor-state';

type Props = {
  tab: Tab; scope: string; readOnly: boolean; minimap?: boolean;
  change: (id: string, text: string) => void;
  focused: () => void;
  mounted: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
};

export function CodePane({ tab, scope, readOnly, change, focused, mounted, minimap = true }: Props) {
  const latest = useRef({ tab, focused, mounted });
  latest.current = { tab, focused, mounted };
  useEffect(() => () => latest.current.mounted(null), []);
  const language = tab.language ?? languageForPath(tab.path);
  return <Editor theme="vs-dark" path={editorModelPath(scope, tab.id, tab.path, tab.language)}
    language={language} value={tab.text} keepCurrentModel saveViewState
    options={{ automaticLayout: true, fontSize: 14, readOnly, insertSpaces: language !== 'makefile',
      detectIndentation: language !== 'makefile', tabSize: 4, minimap: { enabled: minimap },
      scrollBeyondLastLine: false, renderWhitespace: language === 'makefile' ? 'all' : 'selection' }}
    onChange={value => change(tab.id, value ?? '')}
    onMount={editor => {
      latest.current.mounted(editor);
      const focusListener = editor.onDidFocusEditorText(() => latest.current.focused());
      const enterListener = editor.onKeyDown(event => {
        if (event.keyCode !== monaco.KeyCode.Enter || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.browserEvent.isComposing) return;
        const model = editor.getModel(), selection = editor.getSelection();
        if (!model || model.getLanguageId() !== 'markdown' || !selection?.isEmpty() || editor.getSelections()?.length !== 1) return;
        const line = selection.startLineNumber;
        if (selection.startColumn !== model.getLineMaxColumn(line)) return;
        const prefix = model.getValueInRange(new monaco.Range(1, 1, line, 1));
        const next = continueMarkdownList(model.getLineContent(line), prefix);
        if (!next) return;
        event.preventDefault(); event.stopPropagation();
        editor.pushUndoStop();
        editor.executeEdits('markdown-list', [{
          range: next.removeEmptyMarker ? new monaco.Range(line, 1, line, model.getLineMaxColumn(line)) : selection,
          text: next.removeEmptyMarker ? next.prefix : model.getEOL() + next.prefix,
          forceMoveMarkers: true,
        }]);
        editor.pushUndoStop();
      });
      editor.onDidDispose(() => { focusListener.dispose(); enterListener.dispose(); });
    }} />;
}
