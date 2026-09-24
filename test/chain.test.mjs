import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const r=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('extension preserves complete verification chain',async()=>{
  const[b,c,m,e]=await Promise.all([r('extension/background.js'),r('extension/content.js'),r('extension/network-monitor.js'),r('extension/network-evidence.js')]);
  assert.match(b,/verifyAccountCatalogModels/);
  assert.match(b,/verificationTransactions/);
  assert.match(b,/stablePasses < 2/);
  assert.match(c,/pickerMode/);
  assert.match(c,/GPTLOCK_VERIFY_ACCOUNT_MODEL/);
  assert.match(c,/GPTLOCK_VERIFY_ENTER_WORK_MODE/);
  assert.match(c,/second-layer-reacquired/);
  assert.match(m,/Fetch\.requestPaused/);
  assert.match(m,/Network\.requestWillBeSent/);
  assert.match(e,/rewriteConversationPostData/);
});

test('manifest and runtime code versions stay aligned',async()=>{
  const [manifestText,background]=await Promise.all([r('extension/manifest.json'),r('extension/background.js')]);
  const manifest=JSON.parse(manifestText);
  const match=background.match(/const RUNTIME_CODE_VERSION = '([^']+)'/);
  assert.ok(match,'background runtime version marker missing');
  assert.equal(match[1],manifest.version);
});
