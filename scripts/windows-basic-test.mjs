import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import {
  MODELPRO_SCHEMA_VERSION,
  buildVerificationProbe,
  catalogIdentity,
  verificationChronology,
  createVerificationCatalog,
  summarizeVerificationOutcome,
  createModelVerificationHistoryRecord,
} from '../src/model-verification.js';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
const startedAt = new Date().toISOString();
const results = [];
function check(name, fn) {
  const t0 = performance.now();
  try {
    const details = fn();
    results.push({name, ok:true, durationMs:+(performance.now()-t0).toFixed(3), details:details ?? null});
    console.log(`PASS | ${name}`);
  } catch (error) {
    results.push({name, ok:false, durationMs:+(performance.now()-t0).toFixed(3), error:error?.stack || String(error)});
    console.error(`FAIL | ${name} | ${error?.message || error}`);
  }
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
function truthy(value, message) { if (!value) throw new Error(message); }

check('schema version', () => equal(MODELPRO_SCHEMA_VERSION, 1, 'schema'));
check('deterministic probe 1/7', () => {
  const p = buildVerificationProbe('ModelPro 本地验证',1,7);
  equal(p.expectedValue,4590,'probe #1 value');
  truthy(p.text.includes('校验值=<整数>'),'probe output contract missing');
  return p;
});
check('deterministic probe 2/7', () => {
  const p = buildVerificationProbe('ModelPro 本地验证',2,7);
  equal(p.expectedValue,5515,'probe #2 value');
  return p;
});
check('probe ordinals are unique', () => {
  const seen = new Set();
  for(let i=1;i<=20;i++){ const p=buildVerificationProbe('verify',i,20); truthy(!seen.has(p.expectedValue),`duplicate value at ${i}`); seen.add(p.expectedValue); }
  return {unique:seen.size};
});
check('catalog identity priority', () => {
  equal(catalogIdentity({model:'gpt-5.6-sol',rawModel:'x'}),'model:gpt-5.6-sol','model identity');
  equal(catalogIdentity({selectorKey:' ABC '}),'selector:abc','selector identity');
});
check('chronology puts GPT-5.5 first', () => {
  const rows=[{model:'gpt-6-astra'},{model:'gpt-5.6-sol'},{model:'gpt-5.5'}];
  rows.sort((a,b)=>{const x=verificationChronology(a),y=verificationChronology(b); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]-y[i]; return String(x[3]).localeCompare(String(y[3]));});
  equal(rows[0].model,'gpt-5.5','first model');
  return rows.map(x=>x.model);
});
check('growing catalog convergence', () => {
  const events=[];
  const c=createVerificationCatalog({normalizeModel:v=>v||null,onMerged:e=>events.push(e)});
  equal(c.merge({pickerMode:'A',reasoningLevels:['medium'],rows:[{model:'gpt-5.6-sol'},{model:'gpt-5.5'}]},'initial'),2,'initial add');
  equal(c.queue[0].model,'gpt-5.5','5.5 first');
  equal(c.merge({pickerMode:'B',reasoningLevels:['high'],rows:[{model:'gpt-5.6-sol'},{model:'gpt-6-astra'}]},'post-turn'),1,'incremental add');
  equal(c.progress.total,3,'total');
  equal(c.progress.pickerModes.join(','),'A,B','picker modes');
  return {queue:c.queue,progress:c.progress,events};
});
check('outcome verified/partial/unverified', () => {
  equal(summarizeVerificationOutcome({total:3,verified:3,failed:0,requestConfirmed:3}).outcome,'verified','verified');
  equal(summarizeVerificationOutcome({total:3,verified:2,failed:1,requestConfirmed:3}).reason,'response_model_evidence_incomplete','response incomplete');
  equal(summarizeVerificationOutcome({total:3,verified:0,failed:3,requestConfirmed:1}).reason,'account_model_verification_incomplete','account incomplete');
  equal(summarizeVerificationOutcome({total:0}).reason,'account_model_catalog_empty','empty');
});
check('history report shape', () => {
  const rec=createModelVerificationHistoryRecord(99,{startedAt,completedAt:new Date().toISOString(),outcome:'verified',catalogVerification:{total:1,verified:1,failed:0,pickerModes:['A'],results:[{model:'gpt-5.5',verified:true,requestConfirmed:true,responseConfirmed:true,requestId:'local-1',requestModel:'gpt-5.5',responseModel:'gpt-5.5',evidenceSource:'network_response_metadata',turnSettled:true}]}});
  equal(rec.report.schemaVersion,1,'report schema');
  equal(rec.report.type,'modelpro-model-verification-report','report type');
  equal(rec.results[0].verified,true,'history verified');
  return rec;
});
check('stress: 1000 catalog merges/probes', () => {
  const c=createVerificationCatalog();
  for(let i=1;i<=1000;i++){ buildVerificationProbe('stress',i,1000); c.merge({rows:[{model:`gpt-9.${i}-test`}]},'stress'); }
  equal(c.progress.total,1000,'stress total');
  return {total:c.progress.total};
});

const report={
  type:'modelpro-windows-basic-test',
  schemaVersion:1,
  startedAt,
  completedAt:new Date().toISOString(),
  platform:{platform:process.platform,release:os.release(),arch:process.arch,node:process.version,hostname:os.hostname()},
  passed:results.filter(x=>x.ok).length,
  failed:results.filter(x=>!x.ok).length,
  total:results.length,
  results,
};
console.log(`SUMMARY | passed=${report.passed} failed=${report.failed} total=${report.total}`);
if(jsonPath){ fs.mkdirSync(new URL('.', 'file:///'+jsonPath.replaceAll('\\','/')).pathname,{recursive:true}); fs.writeFileSync(jsonPath,JSON.stringify(report,null,2),'utf8'); console.log(`JSON | ${jsonPath}`); }
if(report.failed) process.exitCode=1;
