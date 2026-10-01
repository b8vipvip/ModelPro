import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const start = source.indexOf('function normalizeDisplayedModel(text)');
const end = source.indexOf('\n  function ', start + 1);
assert.ok(start >= 0 && end > start, 'normalizeDisplayedModel must remain extractable');
const fnSource = source.slice(start, end);
const normalizeDisplayedModel = Function(`${fnSource}; return normalizeDisplayedModel;`)();

test('deprecation copy after a bare model name is not absorbed into the model id', () => {
  assert.equal(normalizeDisplayedModel('GPT-5.5 Leaving on October 14'), 'gpt-5.5');
  assert.equal(normalizeDisplayedModel('GPT-5.5'), 'gpt-5.5');
});

test('known model-family suffixes remain canonical', () => {
  assert.equal(normalizeDisplayedModel('GPT-5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(normalizeDisplayedModel('GPT-6 Astra'), 'gpt-6-astra');
});
