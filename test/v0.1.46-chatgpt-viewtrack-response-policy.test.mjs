import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publishableVerificationResults, shouldRetryTransientResponse } from '../extension/model-verification.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

test('redesigned ViewTrack model rows require real hit-test ownership', () => {
  assert.match(content, /function interactionVisible\(element\)/);
  assert.match(content, /distinctModelRows\(picker\)\.filter\(interactionVisible\)/);
  assert.match(content, /function redesignedModelViewOpener\(picker\)/);
  assert.match(content, /model-picker-redesign-model-view/);
  assert.match(content, /picker-mode-a-redesigned-model-view/);
});

test('one canceled HTTP 200 response can be retried but not published unverified', () => {
  const transient = { requestConfirmed:true, responseConfirmed:false, retryCount:0, responseHttpStatus:200, responseBodyError:'net::ERR_ABORTED', responseIssue:'response_body_read_failed', responseModel:null };
  assert.equal(shouldRetryTransientResponse(transient), true);
  assert.equal(shouldRetryTransientResponse({ ...transient, retryCount:1 }), false);
  assert.equal(shouldRetryTransientResponse({ ...transient, responseHttpStatus:500 }), false);
  const results = [
    { model:'gpt-6-luna', verified:false, requestConfirmed:true, responseConfirmed:false },
    { model:'gpt-6-sol', verified:true, requestConfirmed:true, responseConfirmed:true },
  ];
  assert.deepEqual(publishableVerificationResults(results, (value) => value), [results[1]]);
});

test('runtime surfaces stay synchronized across ModelPro releases', () => {
  assert.equal(pkg.version, manifest.version);
  const escapedVersion = manifest.version.replaceAll('.', '\\.');
  assert.match(background, new RegExp(`const RUNTIME_CODE_VERSION = '${escapedVersion}';`));
});
