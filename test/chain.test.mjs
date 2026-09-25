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


test('v0.1.38 recovers picker closed by first debugger attach and background owns automatic diagnostics export',async()=>{
 const content=await r('extension/content.js'); const popup=await r('extension/popup.js');
 assert.match(content,/invalidated_after_debugger_attach/);
 assert.match(content,/picker_reopen_after_debugger_attach/);
 assert.match(content,/model-picker-submenu-after-reopen/);
 assert.doesNotMatch(popup,/finally\{const name=await exportLog\('ModelPro-auto'\)/ );
 assert.match(popup,/autoLogDownload\?\.filename/);
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








test('v0.1.38 sends natural prompt text without verification prefixes and reacquires animated model rows',async()=>{
 const [background,content]=await Promise.all([r('extension/background.js'),r('extension/content.js')]);
 assert.match(background,/probeText: prompt/);
 assert.doesNotMatch(background,/probeText: \`\\\$\\\{marker\\\}/);
 assert.match(content,/composerText\(composer\)\.trim\(\) === probeText/);
 assert.match(content,/verification_model_row_activate/);
 assert.match(content,/candidate\.click\(\)/);
 assert.doesNotMatch(content,/verification_model_row_reacquired/);
 assert.doesNotMatch(background,/sendVerificationReasoningProbe\(tabId, 'ModelPro Work 模式激活验证'/);
});



test('v0.1.38 never sends or reload-recovers an extra Sol unlock turn',async()=>{
 const background=await r('extension/background.js');
 assert.doesNotMatch(background,/verification_sol_picker_b_unlock_started/);
 assert.doesNotMatch(background,/GPTWork GPT-5\.6 Sol 能力解锁验证/);
 assert.doesNotMatch(background,/const unlockProbe = await sendVerificationReasoningProbe/);
 assert.match(background,/const rediscovered = await discoverAccountCatalog\(tabId\)/);
});


test('v0.1.38 has one final model-row activation authority without hit-test retry layers',async()=>{
 const content=await r('extension/content.js');
 const start=content.indexOf('async function selectModelForVerification');
 const end=content.indexOf('async function chooseExact',start);
 const selection=content.slice(start,end);
 assert.match(selection,/source: 'owned-semantic-row'/);
 assert.match(selection,/candidate\.click\(\)/);
 assert.doesNotMatch(selection,/modelPickerPointer\(activeCandidate/);
 assert.doesNotMatch(selection,/verification_model_row_reacquired/);
 assert.doesNotMatch(selection,/verification-model-row-reacquired/);
});



test('v0.1.38 manual verification owns a clean diagnostic session and publishes final Work state',async()=>{
 const background=await r('extension/background.js');
 const auto=background.slice(background.indexOf('async function autoVerify('),background.indexOf('function runtimeLogNativeSyncEnabled'));
 assert.match(auto,/clearRuntimeLogs\(\)/);
 assert.match(auto,/clearAutoVerificationStreamCapture\(\)/);
 assert.match(auto,/state\.autoVerification\.workDiscovery = catalogVerification\.workDiscovery/);
});


test('v0.1.38 packaged prompt bank remains intact without page Work-control dependency',async()=>{
 const [background,bankText]=await Promise.all([r('extension/background.js'),r('extension/prompt-bank.json')]);
 const bank=JSON.parse(bankText);
 assert.equal(bank.prompts.length,100);
 assert.match(background,/chrome\.runtime\.getURL\('prompt-bank\.json'\)/);
 assert.match(background,/crypto\.getRandomValues/);
 assert.doesNotMatch(background,/GPTLOCK_VERIFY_ENTER_WORK_MODE/);
});


test('v0.1.38 distinguishes inline A rows from the real Select-model B catalog',async()=>{
 const content=await r('extension/content.js');
 assert.match(content,/picker-mode-a-advanced-inline-list/);
 assert.match(content,/alreadyVisibleRows\.length && !initialOpener/);
 assert.doesNotMatch(content,/pickerTopologyProbe\('third-layer-reused'/);
 const open=content.slice(content.indexOf('async function openModernModelMenu'),content.indexOf('function rowModelDescriptor'));
 assert.match(open,/const opener = modelSubmenuOpener\(picker\)/);
 assert.match(open,/modelPickerPointer\(activeOpener, 'click', 'model-picker-submenu'\)/);
 assert.match(open,/pickerMode: 'B'/);
});


test('v0.1.38 unlocks real picker B with one normal Work-policy turn after verified Sol',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/verification_work_activation_turn_started/);
 assert.match(background,/sendVerificationReasoningProbe\(tabId, 'work-mode-bootstrap'/);
 assert.match(background,/source: 'normal_work_policy_request'/);
 assert.match(background,/workCatalog\?\.pickerMode === 'B'/);
 assert.match(background,/mergeCatalog\(workCatalog, 'work-picker-b'\)/);
 assert.match(background,/normal_work_turn_picker_b_observed/);
 assert.match(background,/deferred_until_sol_verified/);
 const block=background.slice(background.indexOf('verification_work_activation_turn_started'),background.indexOf('// A completed verified turn'));
 assert.doesNotMatch(block,/recoverStaleVerificationTurn/);
 assert.doesNotMatch(block,/verificationTransactions\.set/);
});


test('v0.1.38 Work completion is owned by observed picker B, not runtime flag alone',async()=>{
 const background=await r('extension/background.js');
 assert.doesNotMatch(background,/runtime_work_enabled_catalog_observed/);
 assert.match(background,/normal_work_turn_picker_b_observed/);
 assert.match(background,/activationSettled\?\.settled === true && workCatalog\?\.pickerMode === 'B'/);
});


test('v0.1.38 Work bootstrap preserves ChatGPT reasoning body while normal policy changes transport',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/const workBootstrapTabs = new Set\(\)/);
 assert.match(background,/preferredReasoning: workBootstrapTabs\.has\(Number\(tabId\)\) \? null : currentSettings\.preferredReasoning/);
 assert.match(background,/preserveReasoning: workBootstrapTabs\.has\(Number\(tabId\)\)/);
 assert.match(background,/workBootstrapTabs\.add\(Number\(tabId\)\)/);
 assert.match(background,/finally \{\s*workBootstrapTabs\.delete\(Number\(tabId\)\)/);
});


test('v0.1.38 retains Fetch-forwarded Work request evidence when Network id is absent',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/state\.lastForwardedRequest = \{/);
 assert.match(background,/fetchRequestId: rewrite\.fetchRequestId/);
 assert.match(background,/const forwardedRequestId = state\.lastForwardedRequest\?\.requestId/);
 assert.match(background,/const requestId = state\.lastRequest\?\.requestId \?\? forwardedRequestId/);
});



test('v0.1.38 background auto exports terminal verification log',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/async function autoDownloadVerificationLog/);
 assert.match(background,/chrome\.downloads\.download/);
 assert.match(background,/auto_verification_log_downloaded/);
});


test('v0.1.38 has one terminal response-model authority and restores Network capture per probe',async()=>{
 const [background,network]=await Promise.all([r('extension/background.js'),r('extension/network-evidence.js')]);
 assert.doesNotMatch(network,/routingModel|routingProfile/);
 assert.doesNotMatch(background,/profileConfirmed|routingModel === target/);
 assert.match(network,/SERVED_MODEL_KEYS\.has\(key\)\) return 150/ );
 assert.match(network,/key === 'default_model_slug'\) return 110/);
 assert.match(background,/networkMonitor\.enableResponseCapture\(tabId\)/);
 assert.match(background,/Response capture did not re-enable before verification probe/);
});


test('v0.1.38 exports exactly one automatic verification file',async()=>{
 const popup=await r('extension/popup.js');
 const background=await r('extension/background.js');
 assert.match(background,/autoDownloadVerificationLog\(\)/);
 assert.doesNotMatch(popup,/finally\{const name=await exportLog\('ModelPro-auto'\)/);
 assert.match(popup,/autoLogDownload\?\.filename/);
});


test('v0.1.38 resolved served-model evidence outranks default fallback and is never downgraded',async()=>{
 const evidence=await r('extension/network-evidence.js');
 const background=await r('extension/background.js');
 assert.match(evidence,/if \(SERVED_MODEL_KEYS\.has\(key\)\) return 150;/);
 assert.match(evidence,/if \(key === 'default_model_slug'\) return 110;/);
 assert.doesNotMatch(background,/default_model_not_served_model/);
 assert.doesNotMatch(background,/weakDefaultOnly/);
});


test('v0.1.38 settles picker B page state before the verification probe',async()=>{
 const background=await r('extension/background.js');
 assert.match(background,/item\.pickerMode === 'B'/);
 assert.match(background,/setTimeout\(resolve, 1200\)/);
 assert.match(background,/picker_b_selection_settled_before_probe/);
 const settle=background.indexOf('picker_b_selection_settled_before_probe');
 const probe=background.indexOf("sendVerificationReasoningProbe(tabId, 'GPTWork 模型验证'");
 assert.ok(settle > 0 && probe > settle);
});


test('v0.1.38 treats exact Work default_model_slug as Picker-B response identity',async()=>{
 const [background,evidence,policy]=await Promise.all([r('extension/background.js'),r('extension/network-evidence.js'),r('extension/policy.js')]);
 assert.match(evidence,/defaultModel: defaultModel\.value/);
 assert.match(evidence,/defaultModelField: defaultModel\.path/);
 assert.match(background,/workProfileConfirmed = Boolean\(workTarget && defaultModel === target\)/);
 assert.match(background,/work_profile_confirmed_by_default_model_slug/);
 assert.match(background,/model: responseEvidence\?\.conflicts\?\.model \? null : \(workProfileConfirmed \? target : observed\)/);
 assert.match(policy,/'gpt-6-luna-wm': 'gpt-6-luna'/);
 assert.match(policy,/'gpt-6-luna': 'gpt-6-luna-wm'/);
 const monitor=await r('extension/network-monitor.js');
 assert.match(monitor,/defaultModel: evidence\.defaultModel/);
 assert.match(monitor,/defaultModelField: evidence\.defaultModelField/);
 assert.match(policy,/'gpt-5\.6-terra': 'gpt-5\.6-terra-wm'/);
 assert.match(policy,/'gpt-5\.6-luna': 'gpt-5\.6-luna-wm'/);
});

test('v0.1.38 extracts real Picker-B Work identity from SSE for all affected profiles',async()=>{
 const [{extractResponseEvidence},{modelTransportId}]=await Promise.all([
   import('../extension/network-evidence.js'),
   import('../extension/policy.js'),
 ]);
 const targets=['gpt-5.6-luna','gpt-5.6-terra','gpt-6-astra','gpt-6-luna','gpt-6-sol'];
 for(const target of targets){
   const transport=modelTransportId(target);
   assert.notEqual(transport,target, target+' must be classified as a Work profile');
   const rawSse=[
     'data: '+JSON.stringify({v:{message:{metadata:{resolved_model_slug:'gpt-5-6',default_model_slug:transport}}}}),
     '',
     'data: '+JSON.stringify({default_model_slug:transport}),
     '',
     'data: [DONE]',
     '',
   ].join('\n');
   const evidence=extractResponseEvidence({body:rawSse,mimeType:'text/event-stream'});
   assert.equal(evidence.model,'gpt-5.6-sol',target+' backend resolved family');
   assert.equal(evidence.defaultModel,target,target+' Work profile identity');
   assert.match(evidence.defaultModelField,/default_model_slug$/,target+' identity field');
 }
});


test('v0.1.38 keeps page-wide long tasks informational and clean detaches non-warning',async()=>{
 const [background,content]=await Promise.all([r('extension/background.js'),r('extension/content.js')]);
 assert.match(content,/const pageLongTaskObserved = performanceTelemetry\.maxLongTaskMs >= 100;/);
 const abnormalStart=content.indexOf('const abnormal = lag >= 120');
 const abnormalEnd=content.indexOf(';',abnormalStart);
 const abnormalExpr=content.slice(abnormalStart,abnormalEnd+1);
 assert.doesNotMatch(abnormalExpr,/maxLongTaskMs/);
 assert.match(content,/pageLongTaskObserved,/);
 assert.match(background,/const detachedWhileWaiting = !monitor\.attached && state\.phase === 'waiting';/);
 assert.match(background,/const monitorLevel = monitor\.attached \|\| \(!monitor\.error && !detachedWhileWaiting\) \? 'info' : 'warn';/);
 assert.match(background,/pageLongTaskObserved: details\.pageLongTaskObserved === true/);
});


test('v0.1.39 automates redesign probing against only the two default Chat models and auto exports',async()=>{
 const [background,content,popupHtml,popupJs]=await Promise.all([
   r('extension/background.js'),
   r('extension/content.js'),
   r('extension/popup.html'),
   r('extension/popup.js'),
 ]);
 assert.match(background,/const targets = \['gpt-5\.5', 'gpt-5\.6-sol'\]/);
 assert.match(background,/MODELPRO_UI_COMPAT_PROBE/);
 assert.match(background,/runUiCompatibilityProbe/);
 assert.match(background,/model_element_test_completed/);
 assert.match(background,/autoDownloadUiCompatibilityLog/);
 assert.match(background,/ui-probe-/);
 assert.match(content,/MODELPRO_UI_PROBE_SNAPSHOT/);
 assert.match(content,/function uiProbeSnapshot/);
 assert.match(content,/selectorCompatibility/);
 assert.match(content,/pageCandidates/);
 assert.match(popupHtml,/id="probe"/);
 assert.match(popupJs,/MODELPRO_UI_COMPAT_PROBE/);
 assert.match(popupJs,/LOG 已自动导出/);
});
