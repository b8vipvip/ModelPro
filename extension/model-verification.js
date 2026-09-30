export const MODELPRO_VERIFICATION_SCHEMA_VERSION = 1;

export function catalogIdentity({ model, rawModel, selectorKey, label } = {}) {
  if (model) return `model:${model}`;
  if (rawModel) return `raw:${rawModel}`;
  const selector = String(selectorKey || '').trim().toLowerCase();
  if (selector) return `selector:${selector}`;
  return `label:${String(label || '').trim().toLowerCase()}`;
}

export function verificationChronology(item, normalizeModel = (value) => value || null) {
  const model = normalizeModel(item?.model || item?.rawModel);
  // GPT-5.5 must run before Work/B activation can make it disappear from the picker.
  if (model === 'gpt-5.5') return [-1, 5, 5, ''];
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.*))?$/.exec(model || '');
  if (!match) {
    return [1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, model || item?.label || ''];
  }
  return [0, Number(match[1]), Number(match[2] || 0), String(match[3] || '')];
}

export function createVerificationCatalog({
  normalizeModel = (value) => value || null,
  onMerged = null,
  workDiscovery = { attempted: false, entered: false, reason: 'pending_after_gpt_5_5' },
} = {}) {
  const queue = [];
  const knownKeys = new Set();
  const reasoningLevels = new Set();
  const progress = {
    total: 0,
    completed: 0,
    requestConfirmed: 0,
    verified: 0,
    failed: 0,
    currentModel: null,
    currentSelectorKey: null,
    currentLabel: null,
    results: [],
    discoveryPasses: 0,
    stablePasses: 0,
    reasoningLevels: [],
    pickerModes: [],
    workDiscovery: { ...workDiscovery },
  };

  const identity = (item) => catalogIdentity({
    model: normalizeModel(item?.model),
    rawModel: normalizeModel(item?.rawModel),
    selectorKey: item?.selectorKey,
    label: item?.label,
  });

  function sortQueue() {
    const completed = new Set(progress.results.map(identity));
    const pending = queue.filter((item) => !completed.has(identity(item)));
    const done = queue.filter((item) => completed.has(identity(item)));
    pending.sort((left, right) => {
      const a = verificationChronology(left, normalizeModel);
      const b = verificationChronology(right, normalizeModel);
      for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
      }
      return String(a[3]).localeCompare(String(b[3]));
    });
    queue.splice(0, queue.length, ...done, ...pending);
  }

  function merge(catalog, phase = 'unknown') {
    let added = 0;
    if (['A', 'B'].includes(catalog?.pickerMode) && !progress.pickerModes.includes(catalog.pickerMode)) {
      progress.pickerModes.push(catalog.pickerMode);
    }
    for (const level of (catalog?.reasoningLevels || [])) reasoningLevels.add(level);

    for (const row of (Array.isArray(catalog?.rows) ? catalog.rows : [])) {
      const model = normalizeModel(row?.model || row?.rawId);
      const rawModel = normalizeModel(row?.rawId);
      const selectorKey = String(row?.selectorKey || '').trim().slice(0, 200);
      const label = String(row?.label || model || selectorKey || '').trim().slice(0, 160);
      if (!model && !selectorKey && !label) continue;

      const candidate = {
        model,
        rawModel,
        selectorKey,
        label,
        pickerMode: ['A', 'B'].includes(row?.pickerMode) ? row.pickerMode : catalog?.pickerMode || null,
      };
      const key = identity(candidate);
      if (knownKeys.has(key)) {
        // A concrete model is the stable identity. Refresh only the still-pending
        // locator/label after ChatGPT rebuilds a picker; never create a second probe.
        const existing = queue.find((item) => identity(item) === key);
        if (existing && !progress.results.some((result) => identity(result) === key)) {
          existing.rawModel = rawModel || existing.rawModel;
          existing.selectorKey = selectorKey || existing.selectorKey;
          existing.label = label || existing.label;
        }
        continue;
      }

      knownKeys.add(key);
      queue.push(candidate);
      added += 1;
    }

    sortQueue();
    progress.total = queue.length;
    progress.reasoningLevels = [...reasoningLevels];
    onMerged?.({
      phase,
      added,
      total: queue.length,
      reasoningLevels: [...progress.reasoningLevels],
      pickerModes: [...progress.pickerModes],
    });
    return added;
  }

  return { queue, knownKeys, reasoningLevels, progress, merge, identity, sortQueue };
}

export function summarizeVerificationOutcome(progress = {}) {
  const total = Number(progress.total || 0);
  const verified = Number(progress.verified || 0);
  const failed = Number(progress.failed || 0);
  const requestConfirmed = Number(progress.requestConfirmed || 0);
  const outcome = total === 0
    ? 'unverified'
    : failed === 0 && verified === total
      ? 'verified'
      : verified > 0
        ? 'partial'
        : 'unverified';
  const reason = total === 0
    ? 'account_model_catalog_empty'
    : failed
      ? requestConfirmed === total
        ? 'response_model_evidence_incomplete'
        : 'account_model_verification_incomplete'
      : null;
  return { outcome, reason, total, verified, failed, requestConfirmed };
}

export function createModelVerificationHistoryRecord(
  tabId,
  autoVerification,
  { reportType = 'modelpro-model-verification-report' } = {},
) {
  const catalog = autoVerification?.catalogVerification || {};
  const record = {
    id: `${autoVerification?.startedAt || new Date().toISOString()}:${tabId}`,
    tabId,
    startedAt: autoVerification?.startedAt ?? null,
    completedAt: autoVerification?.completedAt ?? null,
    outcome: autoVerification?.outcome ?? 'unverified',
    reason: autoVerification?.reason ?? null,
    total: Number(catalog.total || 0),
    verified: Number(catalog.verified || 0),
    failed: Number(catalog.failed || 0),
    pageContext: autoVerification?.pageContext ?? null,
    pickerModes: Array.isArray(catalog.pickerModes) ? [...catalog.pickerModes] : [],
    results: (Array.isArray(catalog.results) ? catalog.results : []).map((item) => ({
      model: item.model ?? null,
      rawModel: item.rawModel ?? null,
      selectorKey: item.selectorKey ?? null,
      label: item.label ?? item.model ?? item.requestModel ?? 'Unknown model',
      verified: item.verified === true,
      requestConfirmed: item.requestConfirmed === true,
      responseConfirmed: item.responseConfirmed === true,
      requestId: item.requestId ?? null,
      requestModel: item.requestModel ?? null,
      networkObservedRequestModel: item.networkObservedRequestModel ?? null,
      responseModel: item.responseModel ?? null,
      evidenceModel: item.evidenceModel ?? null,
      responseReasoning: item.responseReasoning ?? null,
      responseVerdict: item.responseVerdict ?? null,
      responseIssue: item.responseIssue ?? null,
      evidenceSource: item.evidenceSource ?? null,
      pickerMode: item.pickerMode ?? null,
      timedOut: item.timedOut === true,
      turnSettled: item.turnSettled === true,
      error: item.error ?? null,
    })),
  };
  record.report = {
    schemaVersion: MODELPRO_VERIFICATION_SCHEMA_VERSION,
    type: reportType,
    generatedAt: record.completedAt || new Date().toISOString(),
    verification: { ...record },
  };
  return record;
}

export function shouldRetryTransientResponse(result = {}, { maxRetries = 1 } = {}) {
  const retryCount = Math.max(0, Number(result.retryCount || 0));
  const httpStatus = Number(result.responseHttpStatus || 0);
  const bodyError = String(result.responseBodyError || result.error || '');
  return result.requestConfirmed === true
    && result.responseConfirmed !== true
    && retryCount < Math.max(0, Number(maxRetries || 0))
    && httpStatus === 200
    && /(?:net::ERR_ABORTED|network_loading_failed)/i.test(bodyError)
    && (!result.responseModel || result.responseIssue === 'response_body_read_failed');
}

export function publishableVerificationResults(results = [], normalizeModel = (value) => value || null) {
  return (Array.isArray(results) ? results : []).filter((item) => (
    item?.verified === true
      && item?.requestConfirmed === true
      && item?.responseConfirmed === true
      && Boolean(normalizeModel(item?.model || item?.requestModel))
  ));
}
