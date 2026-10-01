import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetryTransientResponse } from '../extension/model-verification.js';

test('retries one HTTP 200 response metadata conflict after request authority is confirmed', () => {
  assert.equal(shouldRetryTransientResponse({
    requestConfirmed: true,
    responseConfirmed: false,
    responseHttpStatus: 200,
    responseIssue: 'response_metadata_conflict',
    responseModel: null,
    retryCount: 0,
  }, { maxRetries: 1 }), true);
});

test('response metadata conflict retry is bounded and gated by request confirmation', () => {
  const base = {
    requestConfirmed: true,
    responseConfirmed: false,
    responseHttpStatus: 200,
    responseIssue: 'response_metadata_conflict',
    responseModel: null,
  };
  assert.equal(shouldRetryTransientResponse({ ...base, retryCount: 1 }, { maxRetries: 1 }), false);
  assert.equal(shouldRetryTransientResponse({ ...base, requestConfirmed: false, retryCount: 0 }, { maxRetries: 1 }), false);
  assert.equal(shouldRetryTransientResponse({ ...base, responseHttpStatus: 500, retryCount: 0 }, { maxRetries: 1 }), false);
});

test('existing no-body aborted response retry remains supported', () => {
  assert.equal(shouldRetryTransientResponse({
    requestConfirmed: true,
    responseConfirmed: false,
    responseHttpStatus: 200,
    responseBodyError: 'net::ERR_ABORTED',
    responseIssue: 'response_body_read_failed',
    responseModel: null,
    retryCount: 0,
  }, { maxRetries: 1 }), true);
});
