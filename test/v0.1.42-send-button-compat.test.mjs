import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const r=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('redesigned composer send compatibility loads before main content runtime',async()=>{
  const [manifestText,packageText,compat]=await Promise.all([
    r('extension/manifest.json'),
    r('package.json'),
    r('extension/composer-send-compat.js'),
  ]);
  const manifest=JSON.parse(manifestText);
  const pkg=JSON.parse(packageText);
  assert.equal(pkg.version,manifest.version);
  const scripts=manifest.content_scripts?.[0]?.js || [];
  const compatIndex=scripts.indexOf('composer-send-compat.js');
  const contentIndex=scripts.indexOf('content.js');
  assert.ok(compatIndex>=0 && contentIndex>compatIndex,'send compatibility must load before content.js');
  assert.match(compat,/data-testid', 'send-button'/);
  assert.match(compat,/button\.type/);
  assert.match(compat,/right-most enabled/);
  assert.match(compat,/发送|send/);
  assert.match(compat,/MutationObserver/);
});
