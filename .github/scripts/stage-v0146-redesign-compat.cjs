const fs = require('node:fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const index = source.indexOf(oldText);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(oldText, index + oldText.length) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return source.slice(0, index) + newText + source.slice(index + oldText.length);
}

let content = read('extension/content.js');
content = replaceOnce(content,
`  function pointerOwnedVisiblePoint(element) {
    if (!element?.isConnected || !visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    // A picker row can extend underneath ChatGPT's fixed Composer at the viewport
    // bottom. Its geometric center is then occluded even though the visible upper
    // portion remains a valid click target. Sample only inside the viewport-visible
    // intersection and keep the exact DOM row as the sole ownership authority.
    const xs = [(left + right) / 2, left + (right - left) * 0.35, left + (right - left) * 0.65];
    const ys = [(top + bottom) / 2, top + Math.min(8, (bottom - top) * 0.25), bottom - Math.min(8, (bottom - top) * 0.25)];
    for (const y of ys) {
      for (const x of xs) {
        const point = { x, y };
        if (pointerStillOwnsPoint(element, point)) return point;
      }
    }
    return null;
  }
`,
`  function pointerOwnedVisiblePoint(element) {
    if (!element?.isConnected || !visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    // A picker row can extend underneath ChatGPT's fixed Composer at the viewport
    // bottom. Its geometric center is then occluded even though the visible upper
    // portion remains a valid click target. Sample only inside the viewport-visible
    // intersection and keep the exact DOM row as the sole ownership authority.
    const xs = [(left + right) / 2, left + (right - left) * 0.35, left + (right - left) * 0.65];
    const ys = [(top + bottom) / 2, top + Math.min(8, (bottom - top) * 0.25), bottom - Math.min(8, (bottom - top) * 0.25)];
    for (const y of ys) {
      for (const x of xs) {
        const point = { x, y };
        if (pointerStillOwnsPoint(element, point)) return point;
      }
    }
    return null;
  }

  // ChatGPT's 2026-09 ViewTrack keeps inactive picker panels mounted with normal
  // dimensions. CSS visibility is therefore observation-only; an actionable model
  // row must also own at least one viewport point through elementFromPoint().
  function interactionVisible(element) {
    return visible(element) && Boolean(pointerOwnedVisiblePoint(element));
  }
`, 'interaction-visible helper');

content = replaceOnce(content,
`    const rows = distinctModelRows(picker);
    const models = new Set(rows.map((row) => rowModelDescriptor(row).model).filter(Boolean));`,
`    const rows = distinctModelRows(picker).filter(interactionVisible);
    const models = new Set(rows.map((row) => rowModelDescriptor(row).model).filter(Boolean));`, 'direct model rows hit-test');

content = replaceOnce(content,
`  function advancedPickerToggle(picker) {
    return [...(picker?.querySelectorAll?.('[role="menuitem"],button,[role="button"]') || [])].filter(visible)
      .find((element) => /advanced|高级|進階|고급|avanzad|erweitert/i.test(normalizedPickerLabel(element))) || null;
  }

  function isModelListScope(scope) {`,
`  function advancedPickerToggle(picker) {
    return [...(picker?.querySelectorAll?.('[role="menuitem"],button,[role="button"]') || [])].filter(visible)
      .find((element) => /advanced|高级|進階|고급|avanzad|erweitert/i.test(normalizedPickerLabel(element))) || null;
  }

  function redesignedModelViewOpener(picker) {
    if (!picker || !visible(picker)) return null;
    const candidates = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => interactionVisible(element))
      .filter((element) => !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'))
      .filter((element) => {
        const descriptor = rowModelDescriptor(element);
        if (descriptor.model || descriptor.rawId) return false;
        if (element.matches?.('[role="slider"],input[type="range"]')) return false;
        if (element.querySelector?.('[role="slider"],input[type="range"]')) return false;
        const label = normalizedPickerLabel(element).replace(/[›»>]+\\s*$/, '').trim();
        return Boolean(normalizeDisplayedReasoning(label));
      });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function isModelListScope(scope) {`, 'redesign model view opener');

content = replaceOnce(content,
`    const redesignedDirectRows = defaultChatDirectModelRows(picker);
    if (redesignedDirectRows.length === 2) {
      pickerTopologyProbe('picker-mode-a-redesigned-direct-chat-list', {
        pageContext,
        pickerMode: 'A',
        ownedPicker: compactElementProbe(picker),
        modelRows: redesignedDirectRows.map((row) => ({
          element: compactElementProbe(row),
          descriptor: rowModelDescriptor(row),
        })),
      });
      return {
        trigger,
        picker,
        opener: null,
        submenu: picker,
        rows: redesignedDirectRows,
        pageContext,
        pickerMode: 'A',
      };
    }

    const initialOpener = modelSubmenuOpener(picker);`,
`    let redesignedDirectRows = defaultChatDirectModelRows(picker);
    if (redesignedDirectRows.length === 2) {
      pickerTopologyProbe('picker-mode-a-redesigned-direct-chat-list', {
        pageContext,
        pickerMode: 'A',
        ownedPicker: compactElementProbe(picker),
        modelRows: redesignedDirectRows.map((row) => ({
          element: compactElementProbe(row),
          descriptor: rowModelDescriptor(row),
        })),
      });
      return {
        trigger,
        picker,
        opener: null,
        submenu: picker,
        rows: redesignedDirectRows,
        pageContext,
        pickerMode: 'A',
      };
    }

    // The latest ChatGPT picker can open on the reasoning slider while its model
    // panel remains mounted in an inactive ViewPanel. Navigate using the exact
    // interaction-visible reasoning summary row, then reacquire only hit-test-owned
    // model rows from the same composer-owned picker.
    const modelViewOpener = redesignedModelViewOpener(picker);
    if (modelViewOpener) {
      pickerTopologyProbe('picker-redesign-reasoning-view-detected', {
        pageContext,
        opener: compactElementProbe(modelViewOpener),
      });
      const navigated = await modelPickerPointer(modelViewOpener, 'click', 'model-picker-redesign-model-view');
      if (navigated) {
        redesignedDirectRows = await waitUntil(() => {
          const rows = defaultChatDirectModelRows(picker);
          return rows.length === 2 ? rows : null;
        }, 2600, 80) || [];
        if (redesignedDirectRows.length === 2) {
          pickerTopologyProbe('picker-mode-a-redesigned-model-view', {
            pageContext,
            pickerMode: 'A',
            ownedPicker: compactElementProbe(picker),
            modelRows: redesignedDirectRows.map((row) => ({
              element: compactElementProbe(row),
              descriptor: rowModelDescriptor(row),
            })),
          });
          return { trigger, picker, opener: null, submenu: picker, rows: redesignedDirectRows, pageContext, pickerMode: 'A' };
        }
      }
    }

    const initialOpener = modelSubmenuOpener(picker);`, 'viewtrack navigation');
write('extension/content.js', content);

let verification = read('extension/model-verification.js');
if (!verification.includes('export function shouldRetryTransientResponse')) {
  verification += `\nexport function shouldRetryTransientResponse(result = {}, { maxRetries = 1 } = {}) {\n  const retryCount = Math.max(0, Number(result.retryCount || 0));\n  const httpStatus = Number(result.responseHttpStatus || 0);\n  const bodyError = String(result.responseBodyError || result.error || '');\n  return result.requestConfirmed === true\n    && result.responseConfirmed !== true\n    && retryCount < Math.max(0, Number(maxRetries || 0))\n    && httpStatus === 200\n    && /(?:net::ERR_ABORTED|network_loading_failed)/i.test(bodyError)\n    && (!result.responseModel || result.responseIssue === 'response_body_read_failed');\n}\n\nexport function publishableVerificationResults(results = [], normalizeModel = (value) => value || null) {\n  return (Array.isArray(results) ? results : []).filter((item) => (\n    item?.verified === true\n      && item?.requestConfirmed === true\n      && item?.responseConfirmed === true\n      && Boolean(normalizeModel(item?.model || item?.requestModel))\n  ));\n}\n`;
}
write('extension/model-verification.js', verification);

const manifestPath = 'extension/manifest.json';
const manifest = JSON.parse(read(manifestPath));
manifest.version = '0.1.46';
write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pkgPath = 'package.json';
const pkg = JSON.parse(read(pkgPath));
pkg.version = '0.1.46';
write(pkgPath, JSON.stringify(pkg));

let background = read('extension/background.js');
background = background.replace("const RUNTIME_CODE_VERSION = '0.1.45';", "const RUNTIME_CODE_VERSION = '0.1.46';");
if (!background.includes("const RUNTIME_CODE_VERSION = '0.1.46';")) throw new Error('ModelPro runtime version sync failed');
write('extension/background.js', background);

const testPath = 'test/v0.1.46-chatgpt-viewtrack-response-policy.test.mjs';
if (!fs.existsSync(testPath)) {
  write(testPath, `import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\nimport { publishableVerificationResults, shouldRetryTransientResponse } from '../extension/model-verification.js';\n\nconst content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');\nconst manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));\nconst pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));\nconst background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');\n\ntest('redesigned ViewTrack model rows require real hit-test ownership', () => {\n  assert.match(content, /function interactionVisible\\(element\\)/);\n  assert.match(content, /distinctModelRows\\(picker\\)\\.filter\\(interactionVisible\\)/);\n  assert.match(content, /function redesignedModelViewOpener\\(picker\\)/);\n  assert.match(content, /model-picker-redesign-model-view/);\n  assert.match(content, /picker-mode-a-redesigned-model-view/);\n});\n\ntest('one canceled HTTP 200 response can be retried but not published unverified', () => {\n  const transient = { requestConfirmed:true, responseConfirmed:false, retryCount:0, responseHttpStatus:200, responseBodyError:'net::ERR_ABORTED', responseIssue:'response_body_read_failed', responseModel:null };\n  assert.equal(shouldRetryTransientResponse(transient), true);\n  assert.equal(shouldRetryTransientResponse({ ...transient, retryCount:1 }), false);\n  assert.equal(shouldRetryTransientResponse({ ...transient, responseHttpStatus:500 }), false);\n  const results = [\n    { model:'gpt-6-luna', verified:false, requestConfirmed:true, responseConfirmed:false },\n    { model:'gpt-6-sol', verified:true, requestConfirmed:true, responseConfirmed:true },\n  ];\n  assert.deepEqual(publishableVerificationResults(results, (value) => value), [results[1]]);\n});\n\ntest('v0.1.46 runtime surfaces are synchronized', () => {\n  assert.equal(manifest.version, '0.1.46');\n  assert.equal(pkg.version, manifest.version);\n  assert.match(background, /const RUNTIME_CODE_VERSION = '0\\.1\\.46';/);\n});\n`);
}

console.log('ModelPro v0.1.46 redesign compatibility staged');
