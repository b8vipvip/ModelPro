(() => {
  const KEY = '__GPTLOCK_PAGE_MODEL_EVIDENCE__';
  const base = globalThis[KEY];
  if (!base || base.astraPatchApplied) return;

  const ASTRA_MODEL_ID = 'gpt-6-astra';
  const SELECTED_MODEL_SELECTORS = Object.freeze([
    "[aria-checked='true']",
    "[aria-selected='true']",
    "[data-state='checked']",
    "[data-state='selected']",
    "[data-selected='true']",
    "button[class*='composer-pill']",
    "button[data-testid*='model' i]",
  ]);
  const MODEL_CONTROL_SELECTOR = [
    "button",
    "[role='button']",
    "[aria-label]",
    "[data-value]",
    "[data-model]",
    "[data-model-id]",
  ].join(',');

  function normalizedLabel(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[✓✔︎✔√]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function astraFromText(value) {
    const text = normalizedLabel(value);
    if (!text) return null;
    const compact = text.replace(/\s+/g, '-');
    if (/(?:^|[^a-z0-9])(?:gpt-)?6(?:\.0)?-astra(?=$|[^a-z0-9])/.test(compact)) {
      return ASTRA_MODEL_ID;
    }
    if (/(?:^|[^a-z0-9])gpt-6-astra(?:[-_.:][a-z0-9._:-]+)(?=$|[^a-z0-9])/.test(compact)) {
      return ASTRA_MODEL_ID;
    }
    return null;
  }

  function modelFromText(value) {
    return astraFromText(value) || base.modelFromText(value);
  }

  function astraRow(element, selected = false) {
    if (!base.visible(element)) return null;
    const values = base.evidenceValues(element);
    const label = values.find((value) => astraFromText(value));
    if (!label) return null;
    return {
      model: ASTRA_MODEL_ID,
      source: 'composer-dom',
      label,
      selected,
    };
  }

  function astraEvidence() {
    const root = base.composerRoot?.() || document;
    const rows = [];
    const seen = new Set();

    for (const selector of SELECTED_MODEL_SELECTORS) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        const row = astraRow(element, true);
        if (row) rows.push(row);
      }
    }

    for (const element of root.querySelectorAll(MODEL_CONTROL_SELECTOR)) {
      if (seen.has(element)) continue;
      seen.add(element);
      const row = astraRow(element, false);
      if (row) rows.push(row);
    }

    if (!rows.length) return null;
    const selected = rows.find((row) => row.selected) || rows[0];
    return {
      model: ASTRA_MODEL_ID,
      source: selected.source,
      label: selected.label,
      ambiguous: false,
      candidates: [ASTRA_MODEL_ID],
    };
  }

  function modelEvidence() {
    const astra = astraEvidence();
    if (astra) return astra;
    return base.modelEvidence();
  }

  function collect() {
    const model = modelEvidence();
    const reasoning = base.reasoningEvidence();
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
    ...base,
    version: '1.2.0-astra',
    astraPatchApplied: true,
    astraFromText,
    modelFromText,
    modelEvidence,
    collect,
  });
})();
