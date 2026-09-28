import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const r=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('v0.1.44 verifies hidden Work profiles after redesigned picker stays A',async()=>{
  const b=await r('extension/background.js');
  for(const id of ['gpt-5.6-luna','gpt-5.6-terra','gpt-6-astra','gpt-6-luna','gpt-6-sol']) assert.ok(b.includes(id));
  assert.match(b,/activationWorkConfirmed/);
  assert.match(b,/activationDefaultModel === activationTarget/);
  assert.match(b,/__work_transport__/);
  assert.match(b,/verification_hidden_work_transport_probe/);
  assert.match(b,/normal_work_turn_work_profile_confirmed_by_default_model/);
  assert.match(b,/const verified = Boolean\(requestId\) && requestConfirmed && responseConfirmed/);
});
