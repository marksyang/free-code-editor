import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareReleaseAssets } from '../scripts/prepare-release-assets.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'editor-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  const output = join(root, 'assets');
  const put = (path, content = 'installer') => { mkdirSync(join(bundle, path, '..'), { recursive: true }); writeFileSync(join(bundle, path), content); };
  return { bundle, output, put, version: '1.0.0', productName: 'Free Code Editor', arch: 'x64' };
}
test('Linux release assets include current installers and exclude old versions', t => {
  const options = fixture(t);
  options.put('deb/editor_0.1.0.deb', 'old');
  options.put('deb/editor_1.0.0.deb', 'deb');
  options.put('appimage/editor_1.0.0.AppImage', 'image');
  const assets = prepareReleaseAssets({ ...options, platform: 'linux' });
  assert.equal(assets.length, 2);
  assert.deepEqual(assets.map(path => readFileSync(path, 'utf8')), ['deb', 'image']);
  assert(assets.every(path => basename(path).startsWith('free-code-editor-1.0.0-linux-x64-')));
  assert.equal(readdirSync(options.output).length, 2);
});
test('Windows release refuses a missing installer format and supports spaced names', t => {
  const options = fixture(t);
  options.put('nsis/Free Code Editor_1.0.0_setup.exe');
  assert.throws(() => prepareReleaseAssets({ ...options, platform: 'win32' }), /Missing win32 .msi/);
  options.put('msi/Free Code Editor_1.0.0_x64_en-US.msi');
  assert.equal(prepareReleaseAssets({ ...options, platform: 'win32' }).length, 2);
});
test('macOS app archives preserve executable permissions', { skip: process.platform === 'win32' && 'Unix tar permission check' }, t => {
  const options = fixture(t);
  const binary = 'macos/Free Code Editor.app/Contents/MacOS/free-code-editor';
  options.put(binary, '#!/bin/sh\necho test\n');
  const metadata = 'macos/Free Code Editor.app/Contents/Info.plist';
  options.put(metadata, '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>');
  chmodSync(join(options.bundle, binary), 0o755);
  const [archive] = prepareReleaseAssets({ ...options, platform: 'darwin' });
  const listing = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /-rwxr-xr-x.*Free Code Editor\.app\/Contents\/MacOS\/free-code-editor/);
  options.put(metadata, '<plist><dict><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>');
  assert.throws(() => prepareReleaseAssets({ ...options, platform: 'darwin' }), /does not match/);
});
test('release versions and tag checks reject mismatched tags', () => {
  const result = spawnSync(process.execPath, ['scripts/check-version.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' } });
  assert.equal(result.status, 0, result.stderr);
  const mismatch = spawnSync(process.execPath, ['scripts/check-version.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0' } });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Tag must match/);
});

for (const newline of ['LF', 'CRLF', 'mixed']) {
  test(`release version check accepts ${newline} TOML line endings`, t => {
    const root = mkdtempSync(join(tmpdir(), 'editor-version-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src-tauri'));
    for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      let content = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
      if (newline === 'CRLF' || (newline === 'mixed' && file.endsWith('Cargo.lock'))) content = content.replaceAll('\n', '\r\n');
      writeFileSync(join(root, file), content);
    }
    const script = fileURLToPath(new URL('../scripts/check-version.mjs', import.meta.url));
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const env = { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` };
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(result.stdout.includes(`Version verified: ${version}`));
    // A real mismatch must still fail after newline normalization.
    const lock = join(root, 'src-tauri/Cargo.lock');
    const content = readFileSync(lock, 'utf8').replace(/(name = "free-code-editor"\r?\nversion = ")[^"]+/, '$1999.0.0');
    writeFileSync(lock, content);
    const mismatch = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /src-tauri\/Cargo\.lock=999\.0\.0/);
    writeFileSync(lock, content.replace('name = "free-code-editor"', 'name = "another-package"'));
    const missing = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /src-tauri\/Cargo\.lock=<missing>/);
  });
}
