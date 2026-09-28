import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r=(path)=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('response verification recovers model evidence from canceled HTTP 200 streams',async()=>{
  const [monitor,manifestText,packageText,background]=await Promise.all([
    r('extension/network-monitor.js'),
    r('extension/manifest.json'),
    r('package.json'),
    r('extension/background.js'),
  ]);
  const manifest=JSON.parse(manifestText);
  const pkg=JSON.parse(packageText);
  assert.equal(pkg.version,manifest.version);
  assert.match(background,new RegExp(`const RUNTIME_CODE_VERSION = '${manifest.version.replaceAll('.','\\.')}'`));
  assert.match(monitor,/RESPONSE_STREAM_CAPTURE_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(monitor,/Network\.streamResourceContent/);
  assert.match(monitor,/Network\.dataReceived/);
  assert.match(monitor,/handleDataReceived\(tabId, params\)/);
  assert.match(monitor,/Boolean\(params\.canceled\) && Number\(record\.status\) === 200 && recoveredBody/);
  assert.match(monitor,/terminalEvent: 'loadingFailed'/);
  assert.match(monitor,/initial_conversation_aborted/);
  assert.match(monitor,/hasResponseMetadataEvidence\(evidence\)/);
  assert.match(monitor,/this\.onEvidence\(tabId/);
  assert.match(monitor,/streamCaptureBytes/);
});
