(() => {
  const KEY = '__GPTLOCK_PAGE_MODEL_EVIDENCE__';
  if (globalThis[KEY]) return;

  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5-6': 'gpt-5.6-sol',
  });
  const FAMILY_ALIASES = Object.freeze({
    'gpt-5.6-sol': ['gpt-5.6 sol', 'gpt 5.6 sol', '5.6 sol'],
    'gpt-5.5': ['gpt-5.5', 'gpt 5.5', '5.5'],
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
    // Visible DOM text is advisory only.  Recognize the established Sol family
    // explicitly, otherwise fall back to the base GPT family.  Do not turn
    // arbitrary trailing UI text (for example "Solji"/"Solmo") into a model ID.
    const compactSol = compact.match(/(?:^|[^a-z0-9])(?:gpt-)?(\d+(?:\.\d+)*)-sol(?:-wm)?(?:$|[^a-z0-9])/);
    if (compactSol) return normalizeModelId(`gpt-${compactSol[1]}-sol`);
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

    // ChatGPT commonly exposes the current family only as visible text on the
    // compact composer pill while aria-label/title remain generic (for example,
    // aria-label="Model selector" with visible text "5.6 Sol 高").  Keep all
    // text/attribute values from the validated chat2api composer controls so the
    // visible model name is not lost just because a generic aria-label exists.
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
    version: '1.1.0',
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
