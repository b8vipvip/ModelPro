import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../src/gptwork-chain/', import.meta.url);
const background = await readFile(new URL('background.js', root), 'utf8');
const content = await readFile(new URL('content.js', root), 'utf8');
const monitor = await readFile(new URL('network-monitor.js', root), 'utf8');
const evidence = await readFile(new URL('network-evidence.js', root), 'utf8');

test('complete GPTWork verification orchestration is preserved', () => {
  assert.match(background, /discoverAccountCatalog/);
  assert.match(background, /verifyAccountCatalogModels/);
  assert.match(background, /verificationTransactions/);
  assert.match(background, /waitForAttemptVerification/);
  assert.match(background, /requestConfirmed/);
  assert.match(background, /responseConfirmed/);
  assert.match(background, /post-turn/);
  assert.match(background, /stablePasses < 2/);
});

test('both picker paths and verification page flow are preserved', () => {
  assert.match(content, /pickerMode/);
  assert.match(content, /pickerMode:\s*['"]A['"]/);
  assert.match(content, /pickerMode:\s*['"]B['"]/);
  assert.match(content, /GPTLOCK_DISCOVER_ACCOUNT_MODELS/);
  assert.match(content, /GPTLOCK_VERIFY_ACCOUNT_MODEL/);
  assert.match(content, /GPTLOCK_VERIFY_ENTER_WORK_MODE/);
  assert.match(content, /GPTLOCK_AUTO_SEND_PROBE/);
  assert.match(content, /GPTLOCK_WAIT_FOR_PROBE_SETTLED/);
});

test('network requestId and response evidence authority are preserved', () => {
  assert.match(monitor, /requestId/);
  assert.match(monitor, /Fetch\.requestPaused/);
  assert.match(monitor, /Network\.requestWillBeSent/);
  assert.match(evidence, /extractRequestEvidence/);
  assert.match(evidence, /rewriteConversationPostData/);
});

test('browser-console reimplementation is not part of canonical baseline', async () => {
  await assert.rejects(readFile(new URL('../browser/ModelPro-Browser-Console.js', import.meta.url), 'utf8'));
});
