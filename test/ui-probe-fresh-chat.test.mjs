import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('UI redesign probe opens a fresh ChatGPT page and transfers control to a persistent runner', async () => {
  const [popup, html] = await Promise.all([
    r('extension/popup.js'),
    r('extension/popup.html'),
  ]);
  assert.match(popup, /async function freshChatProbeTab\(\)/);
  assert.match(popup, /chrome\.tabs\.create\(\{url:'https:\/\/chatgpt\.com\/',active:false\}\)/);
  assert.match(popup, /changeInfo\.status==='complete'/);
  assert.match(popup, /async function armFreshProbe\(tabId\)/);
  assert.match(popup, /chrome\.runtime\.sendMessage\(\{type:'MODELPRO_UI_COMPAT_PROBE',tabId:id\}\)/);
  assert.match(popup, /chrome\.tabs\.update\(t\.id,\{active:true\}\)/);
  assert.match(html, /自动打开全新聊天页/);
});
