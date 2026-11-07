import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

function parseFixture(t, name, target) {
  const fixture = new URL(`./fixtures/${name}`, import.meta.url);
  const result = spawnSync('make', ['-n', '-f', fileURLToPath(fixture), target], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') { t.skip('make is not installed'); return null; }
  assert.equal(result.status, 0, result.stderr);
  return { fixture, output: result.stdout };
}

test('Makefile fixture uses real Tab recipes accepted by make', t => {
  const result = parseFixture(t, 'Makefile', 'default');
  if (!result) return;
  assert.match(result.output, /echo tab-preserved/);
  assert.match(readFileSync(result.fixture, 'utf8'), /^\t@echo tab-preserved$/m);
});

test('custom recipe prefix fixture parses when GNU make supports it', t => {
  const version = spawnSync('make', ['--version'], { encoding: 'utf8' });
  const match = /GNU Make (\d+)\.(\d+)/i.exec(version.stdout ?? '');
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 82)) {
    t.skip('This make version does not support .RECIPEPREFIX'); return;
  }
  const result = parseFixture(t, 'RecipePrefix.mk', 'alternate');
  if (result) assert.match(result.output, /echo prefix-preserved/);
});
