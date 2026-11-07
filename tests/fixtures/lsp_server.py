"""Deterministic stdio LSP peer for Rust integration tests; never opens sockets."""
import json
import sys

texts = {}
languages = {}
saved = {}

def send(message):
    data = json.dumps(message, ensure_ascii=False).encode('utf-8')
    # Intentionally split frames, including UTF-8 content, across writes.
    header = ('Content-Length: %d\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n' % len(data)).encode()
    for piece in (header[:9], header[9:], data[:3], data[3:]):
        sys.stdout.buffer.write(piece)
        sys.stdout.buffer.flush()

while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b'\r\n', b'\n'):
            break
        key, value = line.decode().split(':', 1)
        headers[key.lower()] = value.strip()
    message = json.loads(sys.stdin.buffer.read(int(headers['content-length'])))
    method = message.get('method')
    params = message.get('params', {})
    if method == 'initialize':
        result = {'capabilities': {'positionEncoding': 'utf-16', 'textDocumentSync': {'openClose': True, 'change': 1, 'save': {'includeText': True}},
                  'hoverProvider': True, 'completionProvider': {}, 'definitionProvider': True,
                  'referencesProvider': True, 'renameProvider': True}}
    elif method in ('textDocument/didOpen', 'textDocument/didChange'):
        document = params['textDocument']
        text = document.get('text', params.get('contentChanges', [{}])[0].get('text'))
        texts[document['uri']] = text
        if 'languageId' in document:
            languages[document['uri']] = document['languageId']
        send({'jsonrpc': '2.0', 'method': 'textDocument/publishDiagnostics', 'params': {
            'uri': document['uri'], 'version': document['version'],
            'diagnostics': [{'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 2}},
                             'severity': 2, 'message': '中文 🦀', 'source': 'fake'}]}})
        continue
    elif method == 'textDocument/didSave':
        uri = params['textDocument']['uri']
        saved[uri] = params.get('text', texts.get(uri))
        continue
    elif method == 'textDocument/didClose':
        texts.pop(params['textDocument']['uri'], None)
        continue
    elif method == 'test/getSaved':
        uri = params['textDocument']['uri']
        result = {'text': saved.get(uri), 'language': languages.get(uri)}
    elif method == 'textDocument/hover':
        result = {'contents': {'kind': 'plaintext', 'value': texts[params['textDocument']['uri']]}}
    elif method == 'textDocument/completion':
        result = [{'label': 'completion', 'kind': 3}]
    elif method == 'textDocument/references':
        # Return responses out of order to exercise request correlation.
        send({'jsonrpc': '2.0', 'id': 'nonexistent', 'result': None})
        result = []
    elif method == 'test/ignore':
        continue
    elif method == 'test/crash':
        sys.exit(0)
    elif method == 'test/requestClientEdit':
        send({'jsonrpc': '2.0', 'id': 'server-edit', 'method': 'workspace/applyEdit', 'params': {'edit': {}}})
        continue
    elif message.get('id') == 'server-edit':
        result = message['result']
        send({'jsonrpc': '2.0', 'id': 'client-edit-check', 'result': result})
        continue
    elif method == 'shutdown':
        result = None
    elif method == 'exit':
        sys.exit(0)
    else:
        continue
    if 'id' in message:
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': result})
