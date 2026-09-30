import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publishableVerificationResults, shouldRetryTransientResponse } from '../extension/model-verification.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

test('redesigned ViewTrack model rows are hit-test strict before causal model-view navigation', () => {
  assert.match(content, /function interactionVisible\(element\)/);
  assert.match(content, /function defaultChatDirectModelRows\(picker, \{ requireInteraction = true \} = \{\}\)/);
  assert.match(content, /const rows = requireInteraction \? semanticRows\.filter\(interactionVisible\) : semanticRows;/);
  const openStart = content.indexOf('async function openModernModelMenu()');
  const openEnd = content.indexOf('function rowModelDescriptor(row)', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = content.slice(openStart, openEnd);
  assert.match(open, /let redesignedDirectRows = defaultChatDirectModelRows\(picker\);/);
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
