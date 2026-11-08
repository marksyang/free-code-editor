import { readFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const version = json('package.json').version;
const lock = json('package-lock.json');
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/\[package\][\s\S]*?\nversion = "([^"]+)"/);
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/\[\[package\]\]\nname = "free-code-editor"\nversion = "([^"]+)"/);
const versions = [lock.version, lock.packages[''].version, json('src-tauri/tauri.conf.json').version, cargo?.[1], cargoLock?.[1]];
if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some(value => value !== version)) throw Error(`Release versions disagree: ${[version, ...versions].join(', ')}`);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw Error(`Tag must match v${version}`);
console.log(`Version verified: ${version}`);
