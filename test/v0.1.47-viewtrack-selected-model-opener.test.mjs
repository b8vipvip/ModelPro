import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

test('ViewTrack Select-model opener remains authoritative after its text becomes model plus effort', () => {
  const start = content.indexOf('function redesignedModelViewOpener(picker)');
  const end = content.indexOf('function isModelListScope(scope)', start);
  assert.ok(start >= 0 && end > start);
  const fn = content.slice(start, end);
  assert.match(fn, /exactModelViewName/);
  assert.match(fn, /选择模型/);
  assert.match(fn, /exactModelViewName\.test\(accessibleName\)/);
  assert.ok(
    fn.indexOf('exactModelViewName.test(accessibleName)') < fn.indexOf('const descriptor = rowModelDescriptor(element)'),
    'exact accessible Select-model identity must win before visible text is parsed as GPT-5.5',
  );
});

test('successful ViewTrack navigation cannot fall through and click the same opener a second time', () => {
  const start = content.indexOf('const modelViewOpener = redesignedModelViewOpener(picker)');
  const end = content.indexOf('const initialOpener = modelSubmenuOpener(picker)', start);
  assert.ok(start >= 0 && end > start);
  const section = content.slice(start, end);
  assert.match(section, /picker-redesign-model-view-unresolved/);
  assert.match(section, /return \{ trigger, picker, opener: modelViewOpener, submenu: null, rows: \[\], pageContext, pickerMode: 'A' \};/);
});
