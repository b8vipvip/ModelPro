import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

test('default Chat rows stay hit-test strict until the exact ViewTrack navigation owns the transition', () => {
  const helperStart = content.indexOf('function defaultChatDirectModelRows(picker, { requireInteraction = true } = {})');
  const helperEnd = content.indexOf('function advancedPickerView(picker)', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = content.slice(helperStart, helperEnd);
  assert.match(helper, /const semanticRows = distinctModelRows\(picker\);/);
  assert.match(helper, /const rows = requireInteraction \? semanticRows\.filter\(interactionVisible\) : semanticRows;/);
  assert.match(helper, /models\.has\('gpt-5\.5'\)/);
  assert.match(helper, /models\.has\('gpt-5\.6-sol'\)/);

  const openStart = content.indexOf('async function openModernModelMenu()');
  const openEnd = content.indexOf('function rowModelDescriptor(row)', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = content.slice(openStart, openEnd);
  assert.match(open, /let redesignedDirectRows = defaultChatDirectModelRows\(picker\);/);
  assert.match(open, /modelPickerPointer\(modelViewOpener, 'click', 'model-picker-redesign-model-view'\)/);
  assert.match(open, /defaultChatDirectModelRows\(picker, \{ requireInteraction: false \}\)/);
  assert.ok(
    open.indexOf("modelPickerPointer(modelViewOpener, 'click', 'model-picker-redesign-model-view')")
      < open.indexOf('defaultChatDirectModelRows(picker, { requireInteraction: false })'),
    'semantic-only row reacquisition must be causally downstream of the exact model-view navigation',
  );
});

test('failed unified-picker discovery cannot fabricate a catalog entry from the composer summary', () => {
  const start = content.indexOf('async function discoverAccountModelMetadata()');
  const end = content.indexOf('function diagnosticPerformanceSnapshot', start);
  assert.ok(start >= 0 && end > start);
  const section = content.slice(start, end);
  assert.match(section, /const currentCanJoinCatalog = !modern\.picker \|\| modern\.rows\.length > 0;/);
  assert.match(section, /modern\.pickerMode !== 'B' && currentCanJoinCatalog && current\?\.model/);
  assert.doesNotMatch(
    section,
    /modern\.pickerMode !== 'B' && current\?\.model && !models\.some/,
    'a zero-row unified picker must not be replaced by a trigger-derived current model',
  );
});

test('v0.1.48 runtime surfaces are synchronized', () => {
  assert.equal(manifest.version, '0.1.48');
  assert.equal(pkg.version, manifest.version);
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.1\.48';/);
});
