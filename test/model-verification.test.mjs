import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVerificationProbe,
  createVerificationCatalog,
  summarizeVerificationOutcome,
} from '../src/model-verification.js';

test('probe is deterministic and unique by ordinal', () => {
  const a = buildVerificationProbe('verify', 1, 7);
  const b = buildVerificationProbe('verify', 2, 7);
  assert.equal(a.expectedValue, 127 * 36 + 18);
  assert.equal(b.expectedValue, 134 * 41 + 21);
  assert.notEqual(a.text, b.text);
});

test('catalog puts GPT-5.5 first and converges new rows', () => {
  const catalog = createVerificationCatalog({ normalizeModel: (v) => v || null });
  catalog.merge({ pickerMode: 'A', rows: [{model:'gpt-5.6-sol'}, {model:'gpt-5.5'}] }, 'initial');
  assert.equal(catalog.queue[0].model, 'gpt-5.5');
  assert.equal(catalog.progress.total, 2);
  catalog.merge({ pickerMode: 'B', rows: [{model:'gpt-6-astra'}] }, 'post-turn');
  assert.equal(catalog.progress.total, 3);
  assert.deepEqual(catalog.progress.pickerModes, ['A','B']);
});

test('outcome requires every discovered model for verified', () => {
  assert.equal(summarizeVerificationOutcome({total:2,verified:2,failed:0,requestConfirmed:2}).outcome, 'verified');
  assert.equal(summarizeVerificationOutcome({total:2,verified:1,failed:1,requestConfirmed:2}).reason, 'response_model_evidence_incomplete');
});
