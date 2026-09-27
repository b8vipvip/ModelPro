import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r=(path)=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('fresh-chat UI probe activates the new tab only after a persistent runner is armed',async()=>{
 const popup=await r('extension/popup.js');
 assert.match(popup,/async function armFreshProbe\(tabId\)/);
 assert.match(popup,/chrome\.scripting\.executeScript/);
 assert.match(popup,/__MODELPRO_FRESH_UI_PROBE_ARMED__/);
 assert.match(popup,/选择 ChatGPT 模型/);
 assert.match(popup,/MODELPRO_UI_COMPAT_PROBE/);
 assert.match(popup,/chrome\.tabs\.update\(t\.id,\{active:true\}\)/);
 const arm=popup.indexOf('await armFreshProbe(t.id)');
 const activate=popup.indexOf("chrome.tabs.update(t.id,{active:true})");
 assert.ok(arm>=0 && activate>arm,'persistent probe runner must be armed before activating the fresh tab');
});
