import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r=(path)=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('v0.1.41 owns fresh-tab activation and hydration in background',async()=>{
 const [background,popup]=await Promise.all([r('extension/background.js'),r('extension/popup.js')]);
 assert.match(background,/async function runFreshUiCompatibilityProbe\(\)/);
 assert.match(background,/chrome\.tabs\.create\(\{ url: 'https:\/\/chatgpt\.com\/', active: true \}\)/);
 assert.match(background,/async function waitForUiProbeHydration\(tabId/);
 assert.match(background,/snapshot\?\.trigger/);
 assert.match(background,/MODELPRO_UI_COMPAT_PROBE_FRESH/);
 assert.match(background,/uiCompatibilityProbeTask/);
 assert.match(background,/targets\.every\(\(target\) => catalog\.models\.includes\(target\)\)/);
 assert.match(popup,/MODELPRO_UI_COMPAT_PROBE_FRESH/);
 assert.doesNotMatch(popup,/freshChatProbeTab/);
});
