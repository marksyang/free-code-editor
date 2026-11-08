import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function prepareReleaseAssets({ bundle, output, version, productName, platform = process.platform, arch = process.arch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
  mkdirSync(output, { recursive: true });
  const label = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform] ?? platform;
  const prefix = `free-code-editor-${version}-${label}-${arch}`;
  const assets = [];
  if (platform === 'darwin') {
    const directory = join(bundle, 'macos');
    const app = `${productName}.app`;
    if (!existsSync(join(directory, app, 'Contents', 'MacOS', 'free-code-editor'))) throw Error('macOS application bundle is missing');
    const metadata = join(directory, app, 'Contents', 'Info.plist');
    const plist = readFileSync(metadata, 'utf8');
    let appVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (plist.startsWith('bplist')) {
      const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', metadata], { encoding: 'utf8' });
      if (result.status === 0) appVersion = result.stdout.trim();
    }
    if (appVersion !== version) throw Error(`macOS app version ${appVersion ?? 'unknown'} does not match ${version}`);
    const target = join(output, `${prefix}.app.tar.gz`);
    const result = spawnSync('tar', ['-czf', target, '-C', directory, app], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(`Cannot archive app: ${result.stderr || result.error?.message}`);
    assets.push(target);
  } else {
    const formats = platform === 'win32' ? [['nsis', '.exe'], ['msi', '.msi']] : platform === 'linux' ? [['deb', '.deb'], ['appimage', '.AppImage']] : [];
    if (!formats.length) throw Error(`Unsupported release platform: ${platform}`);
    for (const [directory, extension] of formats) {
      const source = join(bundle, directory);
      const files = existsSync(source) ? readdirSync(source).filter(name => name.endsWith(extension) && name.includes(version)) : [];
      if (!files.length) throw Error(`Missing ${platform} ${extension} installer for ${version}`);
      for (const name of files) {
        const target = join(output, `${prefix}-${basename(name)}`);
        copyFileSync(join(source, name), target);
        assets.push(target);
      }
    }
  }
  return assets;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const assets = prepareReleaseAssets({ bundle: resolve('src-tauri/target/release/bundle'), output: resolve('release-assets'), version: config.version, productName: config.productName });
  console.log(assets.join('\n'));
}
