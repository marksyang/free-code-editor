import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteFileLocation, normalizeUserPath, shortcutLabel } from '../src/platform.ts';

test('Windows save paths support drive roots, Unicode, UNC and extended paths', () => {
  assert.deepEqual(absoluteFileLocation('C:\\中文\\file.rs', true), { directory: 'C:/中文', name: 'file.rs' });
  assert.deepEqual(absoluteFileLocation('C:\\file.rs', true), { directory: 'C:/', name: 'file.rs' });
  assert.deepEqual(absoluteFileLocation('\\\\server\\share\\file.rs', true), { directory: '//server/share', name: 'file.rs' });
  assert.deepEqual(absoluteFileLocation('\\\\?\\C:\\folder\\file.rs', true), { directory: 'C:/folder', name: 'file.rs' });
  assert.deepEqual(absoluteFileLocation('\\\\?\\UNC\\server\\share\\file.rs', true), { directory: '//server/share', name: 'file.rs' });
  for (const path of ['C:relative.rs', 'relative/file.rs', '\\\\server\\share', 'C:\\folder\\']) assert.equal(absoluteFileLocation(path, true), null);
});
test('Unix save paths preserve literal backslashes and root files', () => {
  assert.deepEqual(absoluteFileLocation('/file.rs', false), { directory: '/', name: 'file.rs' });
  assert.deepEqual(absoluteFileLocation('/folder/a\\b.rs', false), { directory: '/folder', name: 'a\\b.rs' });
  assert.equal(absoluteFileLocation('folder/file.rs', false), null);
  assert.equal(absoluteFileLocation('/folder/', false), null);
  assert.equal(normalizeUserPath('src\\nested\\file.ts', true), 'src/nested/file.ts');
});
test('shortcut labels use Ctrl on Windows/Linux and Command on macOS', () => {
  assert.equal(shortcutLabel('⌘⇧P', false), 'Ctrl+Shift+P');
  assert.equal(shortcutLabel('⌘⇧P', true), '⌘⇧P');
});
