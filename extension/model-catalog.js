(() => {
  const STORAGE_KEY = 'discoveredModels';
  const EVIDENCE_STORAGE_KEY = 'discoveredModelEvidence';
  const DISCOVERY_SCHEMA_KEY = 'modelDiscoverySchemaVersion';
  const DISCOVERY_SCHEMA_VERSION = 3;
  const TRUSTED_STATUS_STORAGE_KEY = 'gptlock.trusted-model-status.v1';
  const MAX_DISCOVERED_MODELS = 64;
  const STATE_REFRESH_MS = 10000;
  const PAGE_REFRESH_DELAY_MS = 350;
  const INDICATOR_GAP_PX = 8;
  const VIEWPORT_MARGIN_PX = 12;
  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5-5-instant': 'gpt-5.5',
    'gpt-5-6': 'gpt-5.6-sol',
    'gpt-6-astra-wm': 'gpt-6-astra',
    'gpt-6-sol-wm': 'gpt-6-sol',
  });
  const NON_CONCRETE_MODEL_IDS = new Set(['auto']);
  const PAGE_MODEL_SELECTORS = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'button[aria-label*="model" i][aria-haspopup="menu"]',
    'button[aria-label*="模型"][aria-haspopup="menu"]',
  ];

  let indicator = null;
  let lastState = null;
  let trustedStatus = null;
  let currentPolicy = null;
  let localPageObservation = null;
  let writeQueue = Promise.resolve();
  let lastRememberedFingerprint = '';
  let pendingRememberedFingerprint = '';
  let modelDiscoveryRetryAt = 0;
  let stateRefreshInFlight = false;
  let pageRefreshTimer = null;
  let positionFrame = null;
  let anchorResizeObserver = null;

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    return MODEL_ALIASES[model] ?? model;
  }

  function normalizeConcreteModelId(value) {
    const model = normalizeModelId(value);
    return model && !NON_CONCRETE_MODEL_IDS.has(model) ? model : null;
  }

  function normalizeDisplayedModel(text) {
    if (!text) return null;
    const compact = String(text).trim().toLowerCase().replace(/\s+/g, '-');
    // Visible DOM text is advisory only. Recognize the established Sol family
    // explicitly, otherwise fall back to the base GPT family. Do not turn
    // arbitrary trailing UI text into a model ID.
    const compactSol = compact.match(/(?:^|[^a-z0-9])(?:gpt-)?(\d+(?:\.\d+)*)-sol(?:-wm)?(?:$|[^a-z0-9])/);
    if (compactSol) return normalizeModelId(`gpt-${compactSol[1]}-sol`);
    const explicit = compact.match(/(?:^|[^a-z0-9])gpt-?(\d+(?:\.\d+)*)(?=$|[^a-z0-9.])/);
    return explicit ? normalizeModelId(`gpt-${explicit[1]}`) : null;
  }

  function modelLabel(value) {
    const model = normalizeModelId(value);
    if (!model) return '未识别 / Unknown';
    if (model === 'gpt-5.6-sol') return 'GPT-5.6 Sol';
    if (model === 'gpt-5.5') return 'GPT-5.5';
    if (model.startsWith('gpt-')) {
      return model
        .split('-')
        .map((part, index) => {
          if (index === 0) return 'GPT';
          if (/^\d+(?:\.\d+)*$/.test(part)) return part;
          if (part === 'sol') return 'Sol';
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
    }
    return model;
  }

  function elementTexts(element) {
    return [
      element?.textContent?.trim(),
      element?.getAttribute?.('aria-label')?.trim(),
      element?.getAttribute?.('title')?.trim(),
    ].filter(Boolean);
  }

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!element?.isConnected || !rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  }

  function detectPageModel() {
    const validated = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.collect?.();
    if (validated) return normalizeModelId(validated.model);

    for (const selector of PAGE_MODEL_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        for (const text of elementTexts(element)) {
          const model = normalizeDisplayedModel(text);
          if (model) return model;
        }
      }
    }

    // Never fall back to scanning every button on the page. Streaming responses and
    // Work panels can contain hundreds of buttons; rescanning them on DOM churn was
    // a visible main-thread cost and could also misidentify unrelated controls.
    return null;
  }

  function timestamp(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function effectivePageObservation(state) {
    const remote = state?.pageObservation;
    if (!localPageObservation) return remote ?? null;
    if (!remote || timestamp(localPageObservation.capturedAt) >= timestamp(remote.capturedAt)) return localPageObservation;
    return remote;
  }

  function trustedModelCandidates(state) {
    const values = [];
    const add = (value, source) => {
      const model = normalizeConcreteModelId(value);
      if (!model) return;
      const key = `${source}:${model}`;
      if (!values.some((item) => item.key === key)) values.push({ key, model, source });
    };

    // A concrete model in the formal conversation POST is authoritative for what
    // GPTWork actually sends. Routing aliases such as "auto" are deliberately
    // excluded because they do not identify the serving model.
    add(state?.lastRequest?.model, 'network_request_metadata');

    const verification = state?.lastVerification;
    if (
      verification?.evidenceSource === 'network_response_metadata'
      && !verification?.reasons?.includes?.('model_missing')
    ) {
      add(verification.model, 'network_response_metadata');
    }
    return values;
  }

  function legacySuspiciousModel(value) {
    const model = normalizeConcreteModelId(value);
    if (!model) return true;
    if (/^gpt-5\.6-(?:s|so)$/.test(model)) return true;
    return model !== 'gpt-5.6-sol' && /^gpt-5\.6-sol[a-z0-9]+$/.test(model);
  }

  function hasTrustedNetworkEvidence(item) {
    const sources = Array.isArray(item?.sources) ? item.sources : [];
    return sources.includes('network_request_metadata')
      || sources.includes('network_response_metadata');
  }

  function responseAppliesToLatestRequest(state) {
    const requestAt = timestamp(state?.lastRequest?.capturedAt);
    const verificationAt = timestamp(state?.lastVerification?.verifiedAt);
    if (!requestAt) return true;
    return Boolean(verificationAt && verificationAt >= requestAt - 1000);
  }

  function modelSnapshot(state) {
    const pageObservation = effectivePageObservation(state);
    const pageModel = normalizeModelId(pageObservation?.model);
    const historyHelper = globalThis.__GPTLOCK_MODEL_STATUS_HISTORY__;
    const selected = historyHelper?.selectStatus?.({
      state,
      history: trustedStatus,
      policy: currentPolicy,
    }) || null;

    const stateRequestModel = normalizeModelId(state?.lastRequest?.model);
    const requestModel = normalizeModelId(selected?.request?.id) || stateRequestModel;
    const requestHistorical = Boolean(requestModel && selected?.request?.historical);
    const requestCurrent = selected ? Boolean(selected?.request?.current) : Boolean(stateRequestModel);

    const verification = state?.lastVerification;
    const responseCurrent = responseAppliesToLatestRequest(state);
    const fallbackResponseModel = responseCurrent ? normalizeModelId(verification?.model) : null;
    const responseModel = normalizeModelId(selected?.response?.id) || fallbackResponseModel;
    const responseHistorical = Boolean(responseModel && selected?.response?.historical);
    const fallbackResponseConfirmed = Boolean(
      fallbackResponseModel
      && verification?.evidenceSource === 'network_response_metadata'
      && !verification?.reasons?.includes?.('model_missing')
    );
    const fallbackResponseMismatch = Boolean(
      fallbackResponseModel
      && (verification?.reasons?.includes?.('model_not_allowed') || verification?.verdict === 'mismatch')
    );
    const responseConfirmed = selected?.response?.id
      ? Boolean(selected.response.confirmed)
      : fallbackResponseConfirmed;
    const responseMismatch = selected?.response?.id
      ? Boolean(selected.response.mismatch)
      : fallbackResponseMismatch;

    return {
      page: {
        id: pageModel,
        label: pageModel ? modelLabel(pageModel) : '未识别',
        status: pageModel ? 'observed' : 'unknown',
      },
      request: {
        id: requestModel,
        label: requestModel
          ? `${modelLabel(requestModel)}${requestHistorical ? ' · 最近请求' : ''}`
          : '等待请求',
        status: requestHistorical ? 'request-history' : requestModel ? 'request' : 'waiting',
        historical: requestHistorical,
      },
      response: {
        id: responseModel,
        label: responseModel ? modelLabel(responseModel) : requestCurrent ? '等待当前响应' : '等待响应',
        status: responseMismatch
          ? 'mismatch'
          : responseHistorical
            ? 'confirmed-history'
            : responseConfirmed ? 'confirmed' : responseModel ? 'response' : 'waiting',
        confirmed: responseConfirmed,
        mismatch: responseMismatch,
        historical: responseHistorical,
      },
    };
  }

  function rememberModels(candidates) {
    if (!candidates.length || Date.now() < modelDiscoveryRetryAt) return;
    const fingerprint = candidates
      .map((candidate) => `${normalizeConcreteModelId(candidate?.model) || ''}:${String(candidate?.source || '')}`)
      .filter((value) => !value.startsWith(':'))
      .sort()
      .join('|');
    if (!fingerprint || fingerprint === lastRememberedFingerprint || fingerprint === pendingRememberedFingerprint) return;
    pendingRememberedFingerprint = fingerprint;

    writeQueue = writeQueue.then(async () => {
      const stored = await chrome.storage.sync.get([
        STORAGE_KEY,
        EVIDENCE_STORAGE_KEY,
        DISCOVERY_SCHEMA_KEY,
      ]);
      const storedModels = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      const legacy = storedModels.map(normalizeConcreteModelId).filter(Boolean);
      const storedEvidence = stored[EVIDENCE_STORAGE_KEY] && typeof stored[EVIDENCE_STORAGE_KEY] === 'object'
        ? stored[EVIDENCE_STORAGE_KEY]
        : {};
      const evidence = { ...storedEvidence };
      let changed = Number(stored[DISCOVERY_SCHEMA_KEY] || 0) < DISCOVERY_SCHEMA_VERSION;
      for (const key of Object.keys(evidence)) {
        if (!normalizeConcreteModelId(key)) {
          delete evidence[key];
          changed = true;
        }
      }
      const now = new Date().toISOString();

      // Historical page guesses without provenance remain only when they are
      // concrete IDs. Routing aliases such as auto are purged in schema v3.
      if (Number(stored[DISCOVERY_SCHEMA_KEY] || 0) < DISCOVERY_SCHEMA_VERSION) {
        for (const model of legacy) {
          if (legacySuspiciousModel(model)) continue;
          if (!evidence[model]) {
            evidence[model] = { confirmed: true, sources: ['legacy-v1'], firstSeenAt: now, lastSeenAt: now };
            changed = true;
          }
        }
      }

      for (const candidate of candidates) {
        const model = normalizeConcreteModelId(candidate?.model);
        const source = String(candidate?.source || '');
        if (!model || !source || legacySuspiciousModel(model) && source.startsWith('page_')) continue;
        const previous = evidence[model] && typeof evidence[model] === 'object' ? evidence[model] : {};
        const previousSources = Array.isArray(previous.sources) ? previous.sources : [];
        if (previous.confirmed === true && previousSources.includes(source)) continue;
        const sources = [...new Set([...previousSources, source])];
        evidence[model] = {
          confirmed: true,
          sources,
          firstSeenAt: previous.firstSeenAt || now,
          lastSeenAt: now,
        };
        changed = true;
      }

      const entries = Object.entries(evidence)
        .filter(([model, item]) => normalizeConcreteModelId(model) && item?.confirmed
          && (!legacySuspiciousModel(model) || hasTrustedNetworkEvidence(item)))
        .sort((a, b) => String(a[1]?.lastSeenAt || '').localeCompare(String(b[1]?.lastSeenAt || '')))
        .slice(-MAX_DISCOVERED_MODELS);
      const nextEvidence = Object.fromEntries(entries);
      const next = entries.map(([model]) => model);
      if (JSON.stringify(next) !== JSON.stringify(legacy)) changed = true;
      if (JSON.stringify(nextEvidence) !== JSON.stringify(evidence)) changed = true;

      if (changed) {
        await chrome.storage.sync.set({
          [STORAGE_KEY]: next,
          [EVIDENCE_STORAGE_KEY]: nextEvidence,
          [DISCOVERY_SCHEMA_KEY]: DISCOVERY_SCHEMA_VERSION,
        });
      }
      lastRememberedFingerprint = fingerprint;
      modelDiscoveryRetryAt = 0;
    }).catch(() => {
      // Do not hammer chrome.storage.sync when the browser has already exhausted
      // MAX_WRITE_OPERATIONS_PER_HOUR. The trusted state remains in memory and a
      // later refresh can retry after a quiet period.
      modelDiscoveryRetryAt = Date.now() + 60_000;
    }).finally(() => {
      if (pendingRememberedFingerprint === fingerprint) pendingRememberedFingerprint = '';
    });
  }

  function statusAnchorRect() {
    const statusHost = document.getElementById('gptlock-indicator-host');
    const statusButton = statusHost?.shadowRoot?.querySelector?.('button');
    const target = statusButton || statusHost;
    const rect = target?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function positionIndicator() {
    positionFrame = null;
    const host = indicator?.isConnected ? indicator : ensureIndicator();
    const anchor = statusAnchorRect();
    if (!anchor) {
      host.style.right = `${VIEWPORT_MARGIN_PX}px`;
      host.style.bottom = '52px';
      return;
    }
    const right = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - anchor.right);
    const bottom = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - anchor.top + INDICATOR_GAP_PX);
    host.style.right = `${Math.round(right)}px`;
    host.style.bottom = `${Math.round(bottom)}px`;
  }

  function schedulePosition() {
    if (positionFrame !== null) return;
    positionFrame = window.requestAnimationFrame(positionIndicator);
  }

  function observeStatusAnchor() {
    anchorResizeObserver?.disconnect();
    anchorResizeObserver = null;
    if (typeof ResizeObserver !== 'function') return;
    const statusHost = document.getElementById('gptlock-indicator-host');
    const target = statusHost?.shadowRoot?.querySelector?.('button') || statusHost;
    if (!target) return;
    anchorResizeObserver = new ResizeObserver(schedulePosition);
    anchorResizeObserver.observe(target);
  }

  function ensureIndicator() {
    if (indicator?.isConnected) return indicator;
    const existing = document.getElementById('gptlock-model-indicator-host');
    if (existing?.shadowRoot) {
      indicator = existing;
      schedulePosition();
      return existing;
    }
    existing?.remove();

    const host = document.createElement('div');
    host.id = 'gptlock-model-indicator-host';
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:52px;z-index:2147483647;pointer-events:auto';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        button{display:grid;gap:4px;min-width:214px;border:1px solid rgba(255,255,255,.22);border-radius:13px;padding:8px 10px;
          color:#fff;background:rgba(15,23,42,.68);-webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%);
          font:600 11px/1.25 system-ui,sans-serif;box-shadow:0 5px 18px rgba(15,23,42,.18);cursor:pointer;white-space:nowrap;text-align:left}
        .model-row{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;align-items:center}
        .model-key{opacity:.76;font-weight:650}
        .model-value{font-weight:800;text-align:right;overflow:hidden;text-overflow:ellipsis}
        .model-row[data-status="waiting"] .model-value,.model-row[data-status="unknown"] .model-value{opacity:.65;font-weight:650}
        .model-row[data-status="request-history"] .model-value{color:#dbeafe;opacity:1;font-weight:800}
        .model-row[data-status="confirmed"] .model-value,.model-row[data-status="confirmed-history"] .model-value{color:#dcfce7}
        .model-row[data-status="confirmed-history"] .model-value{opacity:1;font-weight:800}
        .model-row[data-status="mismatch"] .model-value{color:#fee2e2}
        button[data-tone="confirmed"]{background:rgba(21,128,61,.72);border-color:rgba(187,247,208,.48)}
        button[data-tone="request"]{background:rgba(37,99,235,.72);border-color:rgba(191,219,254,.48)}
        button[data-tone="mismatch"]{background:rgba(185,28,28,.74);border-color:rgba(254,202,202,.5)}
        button:focus{outline:3px solid rgba(191,219,254,.8);outline-offset:2px}
      </style>
      <button type="button" data-tone="unknown" title="GPTWork 模型证据 / Model evidence">
        <span class="model-row" data-source="page" data-status="unknown"><span class="model-key">页面模型</span><span class="model-value">未识别</span></span>
        <span class="model-row" data-source="request" data-status="waiting"><span class="model-key">请求模型</span><span class="model-value">等待请求</span></span>
        <span class="model-row" data-source="response" data-status="waiting"><span class="model-key">响应模型</span><span class="model-value">等待响应</span></span>
      </button>`;
    root.querySelector('button').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }, () => void chrome.runtime.lastError);
    });
    document.documentElement.append(host);
    indicator = host;
    observeStatusAnchor();
    schedulePosition();
    return host;
  }

  function updateRow(button, source, model) {
    const row = button.querySelector(`[data-source="${source}"]`);
    if (!row) return;
    row.dataset.status = model.status;
    const value = row.querySelector('.model-value');
    if (value) value.textContent = model.label;
  }

  function render(state) {
    lastState = state ?? lastState;
    const host = ensureIndicator();
    const button = host.shadowRoot.querySelector('button');
    const snapshot = modelSnapshot(lastState);

    updateRow(button, 'page', snapshot.page);
    updateRow(button, 'request', snapshot.request);
    updateRow(button, 'response', snapshot.response);

    button.dataset.tone = snapshot.response.mismatch
      ? 'mismatch'
      : snapshot.response.confirmed
        ? 'confirmed'
        : snapshot.request.id
          ? 'request'
          : 'unknown';

    const pageDetail = snapshot.page.id ? `${snapshot.page.label} (${snapshot.page.id})` : snapshot.page.label;
    const requestDetail = snapshot.request.id ? `${snapshot.request.label} (${snapshot.request.id})` : snapshot.request.label;
    const responseDetail = snapshot.response.id ? `${snapshot.response.label} (${snapshot.response.id})` : snapshot.response.label;
    button.title = [
      `页面模型：${pageDetail}`,
      `请求模型：${requestDetail}`,
      `响应模型：${responseDetail}${snapshot.response.confirmed ? ' · 网络响应已确认' : ''}${snapshot.response.mismatch ? ' · 与锁定策略不一致' : ''}`,
    ].join('\n');

    schedulePosition();
  }

  function consumeState(state, policy = null) {
    if (policy) currentPolicy = policy;
    if (!state) {
      render(lastState);
      return;
    }
    lastState = state;
    rememberModels(trustedModelCandidates(state));
    render(state);
  }

  function refreshPageModel() {
    pageRefreshTimer = null;
    const validated = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.collect?.();
    const model = validated ? normalizeModelId(validated.model) : detectPageModel();
    const previousModel = normalizeModelId(localPageObservation?.model);
    if (model !== previousModel) {
      localPageObservation = model ? {
        model,
        evidenceSource: 'page_dom_live',
        modelEvidenceSource: validated?.modelSource || 'legacy-fallback',
        modelLabel: validated?.modelLabel || '',
        capturedAt: new Date().toISOString(),
      } : null;
      // Page DOM remains useful for the live indicator, but it is not strong enough
      // evidence to permanently add a lockable model. Network request/response evidence
      // will promote the model after a real conversation request.
      render(lastState);
    }
    observeStatusAnchor();
    schedulePosition();
  }

  function schedulePageRefresh() {
    if (pageRefreshTimer !== null) return;
    pageRefreshTimer = window.setTimeout(refreshPageModel, PAGE_REFRESH_DELAY_MS);
  }

  function refreshState() {
    if (stateRefreshInFlight) return;
    stateRefreshInFlight = true;
    chrome.runtime.sendMessage({ type: 'GPTLOCK_GET_STATE' }, (response) => {
      stateRefreshInFlight = false;
      if (chrome.runtime.lastError) return;
      if (response?.ok) consumeState(response.data?.tabState, response.data?.policy);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GPTLOCK_GUARD_STATE') consumeState(message.state, message.policy);
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[TRUSTED_STATUS_STORAGE_KEY]) {
      trustedStatus = changes[TRUSTED_STATUS_STORAGE_KEY].newValue || null;
      render(lastState);
      return;
    }
    if (areaName === 'sync' && changes.policy?.newValue) {
      currentPolicy = changes.policy.newValue;
      render(lastState);
    }
  });

  chrome.storage.local.get(TRUSTED_STATUS_STORAGE_KEY, (stored) => {
    if (chrome.runtime.lastError) return;
    trustedStatus = stored?.[TRUSTED_STATUS_STORAGE_KEY] || null;
    render(lastState);
  });

  const pageModelSelector = PAGE_MODEL_SELECTORS.join(',');
  const pageObserver = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      const target = mutation.target?.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target?.parentElement;
      if (target?.matches?.(pageModelSelector) || target?.closest?.(pageModelSelector)) return true;
      if (mutation.type !== 'childList') return false;
      return [...mutation.addedNodes].some((node) =>
        node?.nodeType === Node.ELEMENT_NODE
        && (node.matches?.(pageModelSelector) || node.querySelector?.(pageModelSelector)));
    });
    if (relevant) schedulePageRefresh();
  });
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-checked', 'aria-selected', 'data-state', 'data-selected', 'data-value', 'data-model', 'data-model-id', 'title', 'data-testid'],
  });

  window.addEventListener('resize', schedulePosition, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshState();
      schedulePageRefresh();
    }
  });

  ensureIndicator();
  refreshPageModel();
  refreshState();
  window.setInterval(() => {
    if (!document.hidden) refreshState();
  }, STATE_REFRESH_MS);
})();