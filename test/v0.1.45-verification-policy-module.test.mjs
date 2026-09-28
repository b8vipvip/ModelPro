import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogIdentity,
  createModelVerificationHistoryRecord,
  createVerificationCatalog,
  summarizeVerificationOutcome,
  verificationChronology,
} from '../extension/model-verification.js';

const normalizeModel = (value) => String(value || '').trim().toLowerCase() || null;

test('catalog identity prefers concrete backend model over mutable picker locator', () => {
  assert.equal(catalogIdentity({ model: 'gpt-5.6-sol', selectorKey: 'old-row' }), 'model:gpt-5.6-sol');
  assert.equal(catalogIdentity({ rawModel: 'gpt-6-astra', selectorKey: 'row' }), 'raw:gpt-6-astra');
  assert.equal(catalogIdentity({ selectorKey: '  PICKER:A:1  ' }), 'selector:picker:a:1');
});

test('verification chronology keeps GPT-5.5 first and then follows version lineage', () => {
  const rows = [
    { model: 'gpt-6-astra' },
    { model: 'gpt-5.6-sol' },
    { model: 'gpt-5.5' },
  ];
  rows.sort((left, right) => {
    const a = verificationChronology(left, normalizeModel);
    const b = verificationChronology(right, normalizeModel);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return String(a[3]).localeCompare(String(b[3]));
  });
  assert.deepEqual(rows.map((item) => item.model), ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra']);
});

test('catalog merge refreshes a pending locator without duplicating the model workload', () => {
  const merged = [];
  const catalog = createVerificationCatalog({ normalizeModel, onMerged: (event) => merged.push(event) });
  catalog.merge({
    pickerMode: 'A',
    reasoningLevels: ['medium'],
    rows: [
      { model: 'gpt-5.6-sol', rawId: 'gpt-5.6-sol', selectorKey: 'old-selector', label: 'Sol' },
      { model: 'gpt-5.5', rawId: 'gpt-5.5', selectorKey: 'gpt55', label: 'GPT-5.5' },
    ],
  }, 'initial');
  catalog.merge({
    pickerMode: 'B',
    reasoningLevels: ['high'],
    rows: [
      { model: 'gpt-5.6-sol', rawId: 'gpt-5.6-sol', selectorKey: 'new-selector', label: 'GPT-5.6 Sol' },
      { model: 'gpt-6-astra', rawId: 'gpt-6-astra', selectorKey: 'astra', label: 'GPT-6 Astra' },
    ],
  }, 'post-turn');

  assert.equal(catalog.queue.length, 3);
  assert.deepEqual(catalog.queue.map((item) => item.model), ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra']);
  assert.equal(catalog.queue.find((item) => item.model === 'gpt-5.6-sol').selectorKey, 'new-selector');
  assert.deepEqual(catalog.progress.reasoningLevels.sort(), ['high', 'medium']);
  assert.deepEqual(catalog.progress.pickerModes, ['A', 'B']);
  assert.equal(catalog.progress.workDiscovery.reason, 'pending_after_gpt_5_5');
  assert.deepEqual(merged.map((item) => [item.phase, item.added, item.total]), [
    ['initial', 2, 2],
    ['post-turn', 1, 3],
  ]);
});

test('completed rows stay ahead of pending rows during dynamic rediscovery', () => {
  const catalog = createVerificationCatalog({ normalizeModel });
  catalog.merge({ rows: [
    { model: 'gpt-5.5', selectorKey: 'a' },
    { model: 'gpt-5.6-sol', selectorKey: 'b' },
  ] }, 'initial');
  catalog.progress.results.push({ model: 'gpt-5.5', verified: true });
  catalog.merge({ rows: [
    { model: 'gpt-6-astra', selectorKey: 'c' },
  ] }, 'post-turn');
  assert.deepEqual(catalog.queue.map((item) => item.model), ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra']);
});

test('verification summary preserves GPTWork terminal outcome semantics', () => {
  assert.deepEqual(summarizeVerificationOutcome({ total: 0 }), {
    outcome: 'unverified', reason: 'account_model_catalog_empty', total: 0, verified: 0, failed: 0, requestConfirmed: 0,
  });
  assert.equal(summarizeVerificationOutcome({ total: 7, verified: 7, failed: 0, requestConfirmed: 7 }).outcome, 'verified');
  assert.equal(summarizeVerificationOutcome({ total: 7, verified: 6, failed: 1, requestConfirmed: 7 }).reason, 'response_model_evidence_incomplete');
  assert.equal(summarizeVerificationOutcome({ total: 7, verified: 2, failed: 5, requestConfirmed: 3 }).reason, 'account_model_verification_incomplete');
});

test('history serializer is portable while retaining consumer report type', () => {
  const record = createModelVerificationHistoryRecord(12, {
    startedAt: '2026-09-28T12:00:00.000Z',
    completedAt: '2026-09-28T12:01:00.000Z',
    outcome: 'verified',
    reason: null,
    pageContext: 'new_chat',
    catalogVerification: {
      total: 1,
      verified: 1,
      failed: 0,
      pickerModes: ['B'],
      results: [{
        model: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        verified: true,
        requestConfirmed: true,
        responseConfirmed: true,
        requestId: 'request-1',
        requestModel: 'gpt-6-astra',
        responseModel: 'gpt-6-astra',
        evidenceSource: 'network_response_metadata',
      }],
    },
  }, { reportType: 'gptwork-model-verification-report' });

  assert.equal(record.id, '2026-09-28T12:00:00.000Z:12');
  assert.equal(record.report.type, 'gptwork-model-verification-report');
  assert.equal(record.report.schemaVersion, 1);
  assert.equal(record.results[0].verified, true);
  assert.equal(record.results[0].responseModel, 'gpt-6-astra');
});
