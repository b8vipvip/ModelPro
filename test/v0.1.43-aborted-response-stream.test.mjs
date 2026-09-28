import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r=(path)=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('v0.1.43 recovers model evidence from canceled HTTP 200 response streams',async()=>{
  const [monitor,manifestText]=await Promise.all([r('extension/network-monitor.js'),r('extension/manifest.json')]);
  const manifest=JSON.parse(manifestText);
  assert.equal(manifest.version,'0.1.43');
  assert.match(monitor,/Network\.streamResourceContent/);
  assert.match(monitor,/Network\.dataReceived/);
  assert.match(monitor,/handleDataReceived\(tabId, params\)/);
  assert.match(monitor,/Boolean\(params\.canceled\) && Number\(record\.status\) === 200 && recoveredBody/);
  assert.match(monitor,/terminalEvent: 'loadingFailed'/);
  assert.match(monitor,/initial_conversation_aborted/);
  assert.match(monitor,/this\.onEvidence\(tabId/);
  assert.match(monitor,/streamCaptureBytes/);
});
