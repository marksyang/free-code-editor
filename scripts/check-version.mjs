import { readFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const toml = path => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const version = json('package.json').version;
const lock = json('package-lock.json');
const cargo = toml('src-tauri/Cargo.toml').match(/\[package\][\s\S]*?\nversion = "([^"]+)"/);
const cargoLock = toml('src-tauri/Cargo.lock').match(/\[\[package\]\]\nname = "free-code-editor"\nversion = "([^"]+)"/);
const versions = {
  'package.json': version,
  'package-lock.json': lock.version,
  'package-lock.json packages[""]': lock.packages?.['']?.version,
  'src-tauri/tauri.conf.json': json('src-tauri/tauri.conf.json').version,
  'src-tauri/Cargo.toml': cargo?.[1],
  'src-tauri/Cargo.lock': cargoLock?.[1],
};
if (!/^\d+\.\d+\.\d+$/.test(version) || Object.values(versions).some(value => value !== version)) {
  throw Error(`Release versions disagree: ${Object.entries(versions).map(([file, value]) => `${file}=${value ?? '<missing>'}`).join(', ')}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw Error(`Tag must match v${version}`);
console.log(`Version verified: ${version}`);
