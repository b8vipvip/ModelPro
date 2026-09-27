import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('UI redesign probe opens and waits for a fresh ChatGPT page automatically', async () => {
  const [popup, html] = await Promise.all([
    r('extension/popup.js'),
    r('extension/popup.html'),
  ]);
  assert.match(popup, /async function freshChatProbeTab\(\)/);
  assert.match(popup, /chrome\.tabs\.create\(\{url:'https:\/\/chatgpt\.com\/',active:false\}\)/);
  assert.match(popup, /changeInfo\.status==='complete'/);
  assert.match(popup, /MODELPRO_UI_COMPAT_PROBE',tabId:t\.id/);
  assert.match(html, /自动打开全新聊天页/);
});
