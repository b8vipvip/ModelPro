const fs = require('node:fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Missing patch anchor: ${label}`);
  return source.replace(oldValue, newValue);
}

const contentPath = 'extension/content.js';
let content = read(contentPath);
const oldOpener = `  function redesignedModelViewOpener(picker) {
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
`;
const newOpener = `  function redesignedModelViewOpener(picker) {
    if (!picker || !visible(picker)) return null;
    const exactModelViewName = /^(?:select model|choose model|选择模型|選擇模型|모델 선택)$/i;
    const candidates = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => interactionVisible(element))
      .filter((element) => !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'))
      .filter((element) => {
        if (element.matches?.('[role="slider"],input[type="range"]')) return false;
        if (element.querySelector?.('[role="slider"],input[type="range"]')) return false;
        // After a real model is selected ChatGPT changes this ViewToggle's visible
        // text from just the effort ("高") to a model+effort summary ("5.5 高").
        // Its exact accessible name remains "选择模型 / Select model" and is the
        // stable navigation authority. Do not misclassify that control as a model row.
        const accessibleName = String(
          element.getAttribute?.('aria-label') || element.getAttribute?.('title') || ''
        ).trim();
        if (exactModelViewName.test(accessibleName)) return true;
        const descriptor = rowModelDescriptor(element);
        if (descriptor.model || descriptor.rawId) return false;
        const label = normalizedPickerLabel(element).replace(/[›»>]+\\s*$/, '').trim();
        return Boolean(normalizeDisplayedReasoning(label));
      });
    return candidates.length === 1 ? candidates[0] : null;
  }
`;
content = replaceOnce(content, oldOpener, newOpener, 'redesigned model-view opener');

const oldNavigationTail = `        if (redesignedDirectRows.length === 2) {
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

    const initialOpener = modelSubmenuOpener(picker);`;
const newNavigationTail = `        if (redesignedDirectRows.length === 2) {
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
        // A dispatched ViewTrack navigation owns this attempt. Falling through to
        // modelSubmenuOpener would click the same Select-model ViewToggle a second
        // time and slide ChatGPT back to the reasoning panel. Fail closed and let
        // the next verification attempt reopen/reacquire the composer picker.
        pickerTopologyProbe('picker-redesign-model-view-unresolved', {
          pageContext,
          pickerMode: 'A',
          opener: compactElementProbe(modelViewOpener),
          ownedPicker: compactElementProbe(picker),
        });
        return { trigger, picker, opener: modelViewOpener, submenu: null, rows: [], pageContext, pickerMode: 'A' };
      }
    }

    const initialOpener = modelSubmenuOpener(picker);`;
content = replaceOnce(content, oldNavigationTail, newNavigationTail, 'ViewTrack single navigation authority');
write(contentPath, content);

const manifestPath = 'extension/manifest.json';
let manifest = read(manifestPath);
manifest = replaceOnce(manifest, '"version": "0.1.46"', '"version": "0.1.47"', 'manifest version');
write(manifestPath, manifest);

const packagePath = 'package.json';
let pkg = read(packagePath);
pkg = replaceOnce(pkg, '"version":"0.1.46"', '"version":"0.1.47"', 'package version');
write(packagePath, pkg);

const backgroundPath = 'extension/background.js';
let background = read(backgroundPath);
background = replaceOnce(background, "const RUNTIME_CODE_VERSION = '0.1.46';", "const RUNTIME_CODE_VERSION = '0.1.47';", 'runtime version');
write(backgroundPath, background);
