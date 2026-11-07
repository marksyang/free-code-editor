import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
let Terminal;
try { ({ Terminal } = createRequire(import.meta.url)('@xterm/xterm')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const write = (terminal, bytes) => new Promise(resolve => terminal.write(bytes, resolve));

test('terminal decodes split UTF-8 PTY bytes and applies ANSI color and cursor controls', { skip: !Terminal && 'Install xterm dependencies' }, async () => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  try {
    const bytes = new TextEncoder().encode('\x1b[31m中😀 \ue0b0 \ue0a0 \uf126\x1b[0m\r\nprogress 10%\r\x1b[2Kdone');
    for (let offset = 0; offset < bytes.length; offset += 2) await write(terminal, bytes.slice(offset, offset + 2));
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '中😀 \ue0b0 \ue0a0 \uf126');
    assert.equal(terminal.buffer.active.getLine(1).translateToString(true), 'done');
    assert.equal(terminal.buffer.active.getLine(0).getCell(0).getFgColor(), 1);
  } finally { terminal.dispose(); }
});

test('terminal forwards interactive input and control characters without interpreting them as shell commands', { skip: !Terminal && 'Install xterm dependencies' }, () => {
  const terminal = new Terminal();
  const received = [];
  const listener = terminal.onData(data => received.push(data));
  try {
    terminal.input('echo 中文\r'); terminal.input('\x03');
    assert.deepEqual(received, ['echo 中文\r', '\x03']);
    terminal.resize(96, 28);
    assert.equal(terminal.cols, 96); assert.equal(terminal.rows, 28);
  } finally { listener.dispose(); terminal.dispose(); }
});
