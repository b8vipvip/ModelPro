import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

test('account catalog fallback requires at least one discovered semantic model row', () => {
  assert.match(content, /const currentCanJoinCatalog = candidateCount > 0;/);
  assert.doesNotMatch(content, /const currentCanJoinCatalog = !modern\.picker \|\| modern\.rows\.length > 0;/);
  assert.match(content, /Without at least one owned semantic model row there is no selectable account catalog/);
});

test('row-backed fallback still supplements a successful picker discovery', () => {
  assert.match(content, /candidateCount = modern\.rows\.length;[\s\S]*for \(const row of modern\.rows\) rememberRow\(row\);/);
  assert.match(content, /candidateCount = rows\.length;[\s\S]*for \(const row of rows\)/);
  assert.match(content, /currentCanJoinCatalog && current\?\.model/);
});

test('v0.1.50 runtime surfaces stay synchronized', () => {
  assert.equal(manifest.version, '0.1.50');
  assert.equal(pkg.version, manifest.version);
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.1\.50';/);
});
