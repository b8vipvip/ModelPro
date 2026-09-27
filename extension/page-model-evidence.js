(() => {
  const KEY = '__GPTLOCK_PAGE_MODEL_EVIDENCE__';
  if (globalThis[KEY]) return;

  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5.6-terra-wm': 'gpt-5.6-terra',
    'gpt-5.6-luna-wm': 'gpt-5.6-luna',
    'gpt-6-astra-wm': 'gpt-6-astra',
    'gpt-6-sol-wm': 'gpt-6-sol',
    'gpt-6-luna-wm': 'gpt-6-luna',
    'gpt-5-6': 'gpt-5.6-sol',
  });
  const FAMILY_ALIASES = Object.freeze({
    'gpt-5.6-sol': ['gpt-5.6 sol', 'gpt 5.6 sol', '5.6 sol'],
    'gpt-5.6-terra': ['gpt-5.6 terra', 'gpt 5.6 terra', '5.6 terra'],
    'gpt-5.6-luna': ['gpt-5.6 luna', 'gpt 5.6 luna', '5.6 luna'],
    'gpt-5.5': ['gpt-5.5', 'gpt 5.5', '5.5'],
    'gpt-6-astra': ['gpt-6 astra', 'gpt 6 astra', '6 astra'],
    'gpt-6-sol': ['gpt-6 sol', 'gpt 6 sol', '6 sol'],
    'gpt-6-luna': ['gpt-6 luna', 'gpt 6 luna', '6 luna'],
  });
  const REASONING_ALIASES = Object.freeze({
    'extra-high': ['extra high', 'extra-high', 'xhigh', '超高'],
    high: ['high', '高级', '高'],
    medium: ['medium', '中级', '中等', '中'],
    low: ['low', '低级', '低', '极速', 'instant', 'fast', 'minimal'],
  });
  const COMPOSER_ROOT_SELECTORS = Object.freeze([
    "form[data-type='unified-composer']",
    'form',
  ]);
  const COMPOSER_SELECTORS = Object.freeze([
    '#prompt-textarea',
    'textarea[placeholder]',
    "div[contenteditable='true'][data-lexical-editor='true']",
    "div[contenteditable='true'].ProseMirror",
    "form div[contenteditable='true']",
    "[contenteditable='true']",
  ]);
  const SELECTED_MODEL_SELECTORS = Object.freeze([
    "[aria-checked='true']",
    "[aria-selected='true']",
    "[data-state='checked']",
    "[data-state='selected']",
    "[data-selected='true']",
    "button[class*='composer-pill']",
    "button[data-testid*='model' i]",
  ]);
  const MODEL_ATTRIBUTE_NAMES = Object.freeze([
    'data-model',
    'data-model-id',
    'data-value',
    'aria-label',
    'title',
  ]);

  function normalize(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeLabel(value) {
    return normalize(value).replace(/[✓✔︎✔√]/g, '').trim();
  }

  function normalizedLabelLower(value) {
    return normalizeLabel(value).toLowerCase();
  }

  function visible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }

  function evidenceValues(element) {
    if (!element) return [];
    const values = [
      ...MODEL_ATTRIBUTE_NAMES.map((name) => element.getAttribute?.(name) || ''),
      element.innerText || '',
      element.textContent || '',
    ]
      .map(normalizeLabel)
      .filter(Boolean);
    return [...new Set(values)];
  }

  function labelOf(element) {
    const values = evidenceValues(element);
    const visibleText = normalizeLabel(element?.innerText || element?.textContent || '');
    return visibleText || values[0] || '';
  }

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    return MODEL_ALIASES[model] ?? model;
  }

  function aliasMatches(text, alias) {
    const haystack = normalizedLabelLower(text);
    const needle = normalizedLabelLower(alias);
    if (!needle) return false;
    let offset = haystack.indexOf(needle);
    while (offset >= 0) {
      const before = offset > 0 ? haystack[offset - 1] : '';
      const afterIndex = offset + needle.length;
      const after = afterIndex < haystack.length ? haystack[afterIndex] : '';
      const boundedBefore = !before || !/[a-z0-9.]/i.test(before);
      const boundedAfter = !after || !/[a-z0-9.]/i.test(after);
      if (boundedBefore && boundedAfter) return true;
      offset = haystack.indexOf(needle, offset + 1);
    }
    return false;
  }

  function modelFromText(value) {
    const text = normalizedLabelLower(value);
    if (!text) return null;

    for (const [family, aliases] of Object.entries(FAMILY_ALIASES)) {
      if (aliases.some((alias) => aliasMatches(text, alias))) return family;
    }

    const compact = text.replace(/\s+/g, '-');
    const compactTier = compact.match(/(?:^|[^a-z0-9])(?:gpt-)?(\d+(?:\.\d+)*)-(astra|pro|sol|terra|luna)(?:-wm)?(?:$|[^a-z0-9])/);
    if (compactTier) return normalizeModelId(`gpt-${compactTier[1]}-${compactTier[2]}`);
    const explicit = compact.match(/(?:^|[^a-z0-9])gpt-?(\d+(?:\.\d+)*)(?=$|[^a-z0-9.])/);
    return explicit ? normalizeModelId(`gpt-${explicit[1]}`) : null;
  }

  function reasoningFromText(value) {
    const text = normalizedLabelLower(value);
    if (!text) return null;
    for (const [level, aliases] of Object.entries(REASONING_ALIASES)) {
      if (aliases.some((alias) => {
        const needle = normalizedLabelLower(alias);
        return text === needle
          || text.startsWith(`${needle} `)
          || text.endsWith(` ${needle}`);
      })) return level;
    }
    return null;
  }

  function composerRoot() {
    for (const selector of COMPOSER_ROOT_SELECTORS) {
      const root = [...document.querySelectorAll(selector)].find((form) =>
        visible(form) && COMPOSER_SELECTORS.some((composerSelector) => form.querySelector(composerSelector)),
      );
      if (root) return root;
    }
    return null;
  }

  function parseControl(element) {
    const values = evidenceValues(element);
    const modelValue = values.find((value) => modelFromText(value));
    const reasoningValue = values.find((value) => reasoningFromText(value));
    const model = modelValue ? modelFromText(modelValue) : null;
    const reasoning = reasoningValue ? reasoningFromText(reasoningValue) : null;
    return {
      element,
      values,
      label: modelValue || reasoningValue || labelOf(element),
      model,
      reasoning,
    };
  }

  function modelReasoningControls() {
    const root = composerRoot();
    if (!root) return [];
    return [...root.querySelectorAll("button,[role='button'],[aria-label],[data-value],[data-model],[data-model-id]")]
      .filter(visible)
      .map(parseControl)
      .filter((item) => item.model || item.reasoning);
  }

  function composerModelTrigger(root = composerRoot()) {
    if (!root) return null;
    return [...root.querySelectorAll("button[aria-haspopup='menu'],[role='button'][aria-haspopup='menu']")]
      .filter(visible)
      .find((element) => /(?:select|choose).*model|model.*selector|选择.*模型|模型.*选择/i.test(
        String(element.getAttribute?.('aria-label') || element.getAttribute?.('title') || ''),
      )) || null;
  }

  function redesignedDefaultChatEvidence() {
    const root = composerRoot();
    const trigger = composerModelTrigger(root);
    if (!trigger) return null;

    const triggerValues = evidenceValues(trigger);
    const triggerModelValue = triggerValues.find((value) => modelFromText(value));
    if (triggerModelValue) {
      return {
        model: modelFromText(triggerModelValue),
        source: 'composer-trigger',
        label: triggerModelValue,
        inferred: false,
      };
    }

    const triggerText = normalizeLabel(trigger.innerText || trigger.textContent || '');
    const expanded = trigger.getAttribute?.('aria-expanded') === 'true';
    if (!expanded) {
      const reasoning = reasoningFromText(triggerText);
      if (reasoning) {
        // 2026-09 default Chat redesign hides the default Sol family and renders only
        // its reasoning level (for example "高"). GPT-5.5 renders "5.5 高", so a
        // closed, reasoning-only model trigger is the stable signature of default Sol.
        return {
          model: 'gpt-5.6-sol',
          source: 'composer-redesign-default-sol',
          label: triggerText,
          inferred: true,
        };
      }
      return null;
    }

    const controlledId = trigger.getAttribute?.('aria-controls') || '';
    const popup = controlledId ? document.getElementById(controlledId) : null;
    if (!popup || !visible(popup)) return null;
    const popupText = normalizeLabel(popup.innerText || popup.textContent || '');
    const hasSol = FAMILY_ALIASES['gpt-5.6-sol'].some((alias) => aliasMatches(popupText, alias));
    const has55 = FAMILY_ALIASES['gpt-5.5'].some((alias) => aliasMatches(popupText, alias));
    if (!hasSol || !has55) return null;

    const opener = [...popup.querySelectorAll("[role='menuitem'],button,[role='button']")]
      .filter(visible)
      .find((element) => /^(?:select model|choose model|选择模型|選擇模型|모델 선택)$/i.test(
        String(element.getAttribute?.('aria-label') || element.getAttribute?.('title') || '').trim(),
      ));
    if (!opener) return null;
    const openerValues = evidenceValues(opener);
    const openerModelValue = openerValues.find((value) => modelFromText(value));
    if (openerModelValue) {
      return {
        model: modelFromText(openerModelValue),
        source: 'open-picker-summary',
        label: openerModelValue,
        inferred: false,
      };
    }
    const openerText = normalizeLabel(opener.innerText || opener.textContent || '');
    if (reasoningFromText(openerText)) {
      // In the same redesigned pair, a reasoning-only summary means the default Sol
      // row is selected. This lets diagnostics confirm the selection before the menu
      // is closed, without depending on a removed aria-checked/data-state marker.
      return {
        model: 'gpt-5.6-sol',
        source: 'open-picker-default-sol',
        label: openerText,
        inferred: true,
      };
    }
    return null;
  }

  function modelEvidence() {
    const root = composerRoot() || document;
    const rows = [];
    const seen = new Set();

    for (const selector of SELECTED_MODEL_SELECTORS) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || !visible(element)) continue;
        seen.add(element);
        const parsed = parseControl(element);
        if (parsed.model) {
          rows.push({
            model: parsed.model,
            source: 'composer-dom',
            label: parsed.values.find((value) => modelFromText(value) === parsed.model) || parsed.label,
            selected: true,
            combined: Boolean(parsed.reasoning),
          });
        }
      }
    }

    for (const item of modelReasoningControls()) {
      if (item.model) {
        rows.push({
          model: item.model,
          source: 'composer-dom',
          label: item.values.find((value) => modelFromText(value) === item.model) || item.label,
          selected: false,
          combined: Boolean(item.reasoning),
        });
      }
    }

    const preferredRows = rows.filter((row) => row.selected || row.combined);
    const preferredModels = [...new Set(preferredRows.map((item) => item.model).filter(Boolean))];
    const models = [...new Set(rows.map((item) => item.model).filter(Boolean))];
    const effectiveModels = preferredModels.length === 1 ? preferredModels : models;

    if (effectiveModels.length === 1) {
      const model = effectiveModels[0];
      const row = preferredRows.find((item) => item.model === model)
        || rows.find((item) => item.model === model);
      return {
        model,
        source: row?.source || 'composer-dom',
        label: row?.label || '',
        ambiguous: false,
        candidates: models,
      };
    }

    if (effectiveModels.length === 0) {
      const redesigned = redesignedDefaultChatEvidence();
      if (redesigned?.model) {
        return {
          model: redesigned.model,
          source: redesigned.source,
          label: redesigned.label || '',
          ambiguous: false,
          candidates: [redesigned.model],
        };
      }
    }

    return {
      model: null,
      source: effectiveModels.length > 1 ? 'ambiguous-dom' : 'none',
      label: '',
      ambiguous: effectiveModels.length > 1,
      candidates: models,
    };
  }

  function reasoningEvidence() {
    const candidates = modelReasoningControls().filter((item) => item.reasoning);
    if (!candidates.length) return { reasoning: null, source: 'none', label: '' };
    const combined = candidates.find((item) => item.model);
    const item = combined || candidates[0];
    return {
      reasoning: item.reasoning,
      source: 'composer-dom',
      label: item.values.find((value) => reasoningFromText(value) === item.reasoning) || item.label,
    };
  }

  function collect() {
    const model = modelEvidence();
    const reasoning = reasoningEvidence();
    return {
      model: model.model,
      reasoning: reasoning.reasoning,
      modelSource: model.source,
      reasoningSource: reasoning.source,
      modelLabel: model.label,
      reasoningLabel: reasoning.label,
      ambiguous: model.ambiguous,
      candidates: model.candidates,
    };
  }

  globalThis[KEY] = Object.freeze({
    version: '1.2.0',
    composerRoot,
    evidenceValues,
    labelOf,
    visible,
    modelFromText,
    reasoningFromText,
    modelReasoningControls,
    modelEvidence,
    reasoningEvidence,
    collect,
  });
})();
