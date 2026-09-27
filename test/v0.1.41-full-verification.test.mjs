import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r=(path)=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('fresh probe continues into full network verification only after UI success',async()=>{
  const [popup,html,manifestText,packageText,background]=await Promise.all([
    r('extension/popup.js'),
    r('extension/popup.html'),
    r('extension/manifest.json'),
    r('package.json'),
    r('extension/background.js'),
  ]);
  const manifest=JSON.parse(manifestText);
  const pkg=JSON.parse(packageText);
  assert.equal(pkg.version,manifest.version);
  assert.match(background,new RegExp(`const RUNTIME_CODE_VERSION = '${manifest.version.replace(/\./g,'\\.')}'`));
  assert.match(popup,/MODELPRO_UI_COMPAT_PROBE/);
  assert.match(popup,/ui\?\.data\?\.success!==true/);
  assert.match(popup,/GPTLOCK_AUTO_VERIFY/);
  assert.ok(popup.indexOf("MODELPRO_UI_COMPAT_PROBE") < popup.indexOf("GPTLOCK_AUTO_VERIFY"));
  assert.match(html,/先 UI → 再网络/);
});
