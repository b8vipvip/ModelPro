import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const r = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');

test('redesigned default Chat current model evidence covers closed and open picker states', async () => {
  const evidence = await r('extension/page-model-evidence.js');
  assert.match(evidence, /function redesignedDefaultChatEvidence\(\)/);
  assert.match(evidence, /composer-redesign-default-sol/);
  assert.match(evidence, /open-picker-default-sol/);
  assert.match(evidence, /open-picker-summary/);
  assert.match(evidence, /aria-expanded/);
  assert.match(evidence, /gpt-5\.6-sol/);
  assert.match(evidence, /gpt-5\.5/);
});

test('redesigned evidence still recognizes Work profile names explicitly before fallback inference', async () => {
  const evidence = await r('extension/page-model-evidence.js');
  for (const model of ['gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-terra','gpt-5.6-luna']) {
    assert.match(evidence, new RegExp(model.replaceAll('.', '\\.')));
  }
  assert.match(evidence, /const triggerModelValue = triggerValues\.find\(\(value\) => modelFromText\(value\)\)/);
  assert.match(evidence, /if \(triggerModelValue\)/);
});
