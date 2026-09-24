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


test('popup version and diagnostic filename come from manifest',async()=>{
  const [popupHtml,popupJs,manifestText,packageText]=await Promise.all([r('extension/popup.html'),r('extension/popup.js'),r('extension/manifest.json'),r('package.json')]);
  const manifest=JSON.parse(manifestText);const pkg=JSON.parse(packageText);
  assert.doesNotMatch(popupHtml,/ModelPro 0\.1\.0/);
  assert.match(popupJs,/chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(popupJs,/ModelPro-v/);
  assert.equal(pkg.version,manifest.version);
});


test('standalone runtime does not reconnect when native messaging API is unavailable',async()=>{
  const background=await r('extension/background.js');
  assert.match(background,/typeof chrome\.runtime\.connectNative !== 'function'/);
  assert.match(background,/Native messaging is not part of standalone ModelPro/);
});


test('standalone verification reinjects content scripts into pre-existing ChatGPT tabs',async()=>{
 const manifest=JSON.parse(await r('extension/manifest.json')); const background=await r('extension/background.js');
 assert.ok(manifest.permissions.includes('scripting'));
 assert.match(background,/content_scripts_reinjected/);
 assert.match(background,/chrome\.scripting\.executeScript/);
 assert.match(background,/Receiving end does not exist/);
});


test('v0.1.5 recovers picker closed by first debugger attach and popup auto-exports diagnostics',async()=>{
 const content=await r('extension/content.js'); const popup=await r('extension/popup.js');
 assert.match(content,/invalidated_after_debugger_attach/);
 assert.match(content,/picker_reopen_after_debugger_attach/);
 assert.match(content,/model-picker-submenu-after-reopen/);
 assert.match(popup,/finally\{const name=await exportLog\('ModelPro-auto'\)/);
 assert.match(popup,/测试已结束，LOG 已自动导出/);
});


test('v0.1.6 verifies response evidence locally without GPTWork native host',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/standalone: true/);
 assert.match(background,/normalizeConcreteModelId\(observation\?\.model\)/);
 assert.doesNotMatch(background,/async function verifyObservation[\\s\\S]{0,300}sendNative\('verify'/);
 assert.match(background,/absent reasoning is incomplete metadata, not a reason to discard concrete/);
});


test('v0.1.7 standalone active paths omit Native Host residue',async()=>{
 const background=await r('extension/background.js');
 const init=background.slice(background.indexOf('async function performInitialize'),background.indexOf('function initialize()',background.indexOf('async function performInitialize')));
 const diag=background.slice(background.indexOf('async function createDiagnosticBundle'),background.indexOf('chrome.runtime.onMessage'));
 assert.doesNotMatch(init,/refreshNativeCore/);
 assert.doesNotMatch(diag,/sendNative|nativeDiagnostics|nativeStatus/);
 assert.doesNotMatch(background,/nativeAuditCount: bundle\.nativeDiagnostics/);
});
