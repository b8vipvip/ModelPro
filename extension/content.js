(() => {
  const MODEL_SELECTORS = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'button[aria-label*="model" i][aria-haspopup="menu"]',
    'button[aria-label*="模型"][aria-haspopup="menu"]',
    'button.__composer-pill[aria-haspopup="menu"]',
    'button[class*="__composer-pill"][aria-haspopup="menu"]',
    'button[aria-haspopup="menu"][data-tone="neutral"]',
  ];
  const REASONING_SELECTORS = [
    '[data-testid*="reasoning"] button',
    'button[data-testid*="reasoning"]',
    'button[data-testid*="thinking"]',
    'button[aria-label*="reasoning" i][aria-haspopup]',
    'button[aria-label*="thinking" i][aria-haspopup]',
    'button[aria-label*="推理"][aria-haspopup]',
    'button[aria-label*="思考"][aria-haspopup]',
  ];
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送消息"]',
  ];
  const GENERATING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ];
  const VERIFICATION_WORK_LABEL = /^(?:工作|work)$/i;
  const AUTO_PROBE_TEXT = 'GPTWork 模型验证测试：请只回复“验证完成”。';

  function visibleGeneratingControl() {
    return GENERATING_SELECTORS
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((element) => (
        visible(element)
        && !element.disabled
        && element.getAttribute?.('aria-disabled') !== 'true'
        && element.getAttribute?.('data-disabled') !== 'true'
      )) || null;
  }
  const BLOCKING_GUARD_HEARTBEAT_MS = 1500;
  const BLOCKING_GUARD_MAX_AGE_MS = 4500;
  // Model-picker mutation has one authority: an explicit composer-owned transaction.
  // Observation may inspect page-wide topology, but execution may only follow DOM
  // elements causally owned by the active composer trigger.

  let reportTimer = null;
  let alignTimer = null;
  let previousFingerprint = '';
  let cachedState = null;
  let cachedPolicy = null;
  let cachedSettings = null;
  let lastUrl = location.href;
  let lastAlignAttempt = '';
  let lastAlignAt = 0;
  let sendConsumedAt = 0;
  let indicator = null;
  let autoProbeRunning = false;
  let autoVerificationRunning = false;
  let lastRuntimeContactAt = Date.now();
  let pointerTraceSeq = 0;
  // legacy-core-maintenance: diagnostic pointer provenance only; no selection policy or private-engine behavior.

  function compactElementProbe(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect?.();
    const attrs = {};
    for (const name of ['id','class','role','aria-label','aria-haspopup','aria-expanded','aria-controls','data-testid','data-state']) {
      const value = element.getAttribute?.(name);
      if (value) attrs[name] = String(value).slice(0, 240);
    }
    const ancestors = [];
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      ancestors.push({
        tag: node.tagName?.toLowerCase?.() || '',
        id: String(node.id || '').slice(0, 100),
        role: String(node.getAttribute?.('role') || '').slice(0, 100),
        testid: String(node.getAttribute?.('data-testid') || '').slice(0, 160),
        cls: String(node.className || '').slice(0, 180),
      });
    }
    return {
      tag: element.tagName?.toLowerCase?.() || '',
      attrs,
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      ancestors,
    };
  }

  function setAutoVerificationOwnership(running) {
    autoVerificationRunning = running === true;
    if (autoVerificationRunning) document.documentElement.dataset.gptworkAutoVerification = 'running';
    else delete document.documentElement.dataset.gptworkAutoVerification;
  }

  function pointerTrace(event, details = {}) {
    void sendMessage({ type: 'GPTLOCK_POINTER_TRACE', event, details }).catch(() => {});
  }

  function pickerProbeRows(scope) {
    if (!scope) return [];
    return [...scope.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="radio"],[role="option"],[data-radix-collection-item]')]
      .filter((element) => visible(element))
      .slice(0, 40)
      .map((element) => compactElementProbe(element));
  }

  function lightElementProbe(element) {
    const full = compactElementProbe(element);
    if (!full) return null;
    return { tag: full.tag, attrs: full.attrs, text: full.text, rect: full.rect };
  }

  function pickerTopologyProbe(stage, details = {}) {
    const trigger = composerIntelligenceTrigger();
    const picker = visibleIntelligencePickerContent();
    const popups = typeof modelPopupScopes === 'function' ? modelPopupScopes() : [];
    // Keep verification topology useful without persisting tens of kilobytes of
    // repeated ancestor/class data on every picker transition.
    pointerTrace('picker_topology', {
      stage,
      href: location.href,
      contextKind: location.pathname === '/' ? 'new-chat' : (location.pathname.startsWith('/c/') ? 'conversation' : 'other'),
      trigger: lightElementProbe(trigger),
      picker: lightElementProbe(picker),
      pickerRows: pickerProbeRows(picker).slice(0, 18).map((row) => ({ tag: row.tag, attrs: row.attrs, text: row.text, rect: row.rect })),
      popupCount: popups.length,
      popups: popups.slice(0, 6).map((scope) => ({
        scope: lightElementProbe(scope),
        rows: pickerProbeRows(scope).slice(0, 18).map((row) => row.text || ''),
      })),
      ...details,
    });
  }

  function passiveComposerTopologyProbe(stage) {
    const prompt = findComposer();
    const ancestry = [];
    let node = prompt;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const controls = [...node.querySelectorAll('button,[role="button"],[aria-haspopup]')]
        .filter(visible)
        .slice(0, 40)
        .map(compactElementProbe);
      ancestry.push({ depth, node: compactElementProbe(node), controls });
    }
    pointerTrace('passive_composer_topology', {
      stage,
      href: location.href,
      prompt: compactElementProbe(prompt),
      ancestry,
    });
  }

  let passivePickerObserver = null;
  let passivePickerFingerprint = '';
  const performanceTelemetry = {
    mutationCount: 0,
    mutationCallbacks: 0,
    maxMutationCallbackMs: 0,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    recentLongTasks: [],
    lastReportedAt: 0,
  };

  function recordMutationCost(count, startedAt) {
    performanceTelemetry.mutationCount += Math.max(0, Number(count) || 0);
    performanceTelemetry.mutationCallbacks += 1;
    performanceTelemetry.maxMutationCallbackMs = Math.max(
      performanceTelemetry.maxMutationCallbackMs,
      Math.max(0, performance.now() - startedAt),
    );
  }

  function reportPerformanceTelemetry(eventLoopLagMs = 0) {
    const now = Date.now();
    const lag = Math.max(0, Number(eventLoopLagMs) || 0);
    let lifecycle = globalThis.__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__?.diagnosticsSnapshot?.() || null;
    const callbackMaxMs = lifecycle?.callbacks
      ? Math.max(0, ...Object.values(lifecycle.callbacks).map((item) => Number(item?.maxMs || 0)))
      : 0;
    const abnormal = lag >= 120
      || performanceTelemetry.maxLongTaskMs >= 100
      || performanceTelemetry.maxMutationCallbackMs >= 40
      || performanceTelemetry.mutationCount >= 5000
      || callbackMaxMs >= 40;
    // Hidden tabs are timer-throttled by Chromium; that delay is not user-visible
    // jank and must not be reported as event-loop lag.
    if (document.visibilityState !== 'visible' && lag > 0) return;
    const periodicDue = now - performanceTelemetry.lastReportedAt >= 30000;
    if (!periodicDue) return;
    lifecycle = globalThis.__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__?.diagnosticsSnapshot?.({ resetCallbacks: true }) || lifecycle;
    performanceTelemetry.lastReportedAt = now;
    const details = {
      eventLoopLagMs: Math.round(lag),
      maxLongTaskMs: Math.round(performanceTelemetry.maxLongTaskMs),
      longTaskCount: performanceTelemetry.longTaskCount,
      recentLongTasks: performanceTelemetry.recentLongTasks.slice(-8),
      mutationCount: performanceTelemetry.mutationCount,
      mutationCallbacks: performanceTelemetry.mutationCallbacks,
      maxMutationCallbackMs: Math.round(performanceTelemetry.maxMutationCallbackMs * 10) / 10,
      verificationRunning: autoVerificationRunning || cachedState?.autoVerification?.running === true,
      documentVisibility: document.visibilityState,
      abnormal,
      runtimeLifecycle: lifecycle,
    };
    performanceTelemetry.mutationCount = 0;
    performanceTelemetry.mutationCallbacks = 0;
    performanceTelemetry.maxMutationCallbackMs = 0;
    performanceTelemetry.longTaskCount = 0;
    performanceTelemetry.maxLongTaskMs = 0;
    performanceTelemetry.recentLongTasks = [];
    void sendMessage({ type: 'GPTLOCK_PERFORMANCE_DIAGNOSTIC', details }).catch(() => {});
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = Math.max(0, Number(entry.duration) || 0);
        performanceTelemetry.longTaskCount += 1;
        performanceTelemetry.maxLongTaskMs = Math.max(performanceTelemetry.maxLongTaskMs, duration);
        const attribution = Array.isArray(entry.attribution)
          ? entry.attribution.slice(0, 4).map((item) => ({
            name: String(item?.name || '').slice(0, 120),
            entryType: String(item?.entryType || '').slice(0, 80),
            containerType: String(item?.containerType || '').slice(0, 80),
            containerName: String(item?.containerName || '').slice(0, 120),
            containerId: String(item?.containerId || '').slice(0, 120),
            containerSrc: String(item?.containerSrc || '').slice(0, 240),
          }))
          : [];
        performanceTelemetry.recentLongTasks.push({
          startedAt: Math.round((Number(entry.startTime) || 0) * 10) / 10,
          durationMs: Math.round(duration * 10) / 10,
          attribution,
        });
        if (performanceTelemetry.recentLongTasks.length > 16) {
          performanceTelemetry.recentLongTasks.splice(0, performanceTelemetry.recentLongTasks.length - 16);
        }
      }
      reportPerformanceTelemetry(0);
    });
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    // Long Task API is not available in every Chromium execution context.
  }

  let performanceTickExpected = performance.now() + 5000;
  let performanceTickVisibility = document.visibilityState;
  window.setInterval(() => {
    const now = performance.now();
    const visibility = document.visibilityState;
    // A tab that was hidden during the sampling interval can be timer-throttled by
    // Chromium. Never convert that hidden interval into a foreground jank sample.
    const lag = visibility === 'visible' && performanceTickVisibility === 'visible'
      ? Math.max(0, now - performanceTickExpected)
      : 0;
    performanceTickExpected = now + 5000;
    performanceTickVisibility = visibility;
    reportPerformanceTelemetry(lag);
  }, 5000);

  function passivePickerSnapshot(reason = 'dom-change') {
    const popups = typeof modelPopupScopes === 'function' ? modelPopupScopes() : [];
    const visiblePopups = popups.filter(visible);
    const modelLike = visiblePopups.map((scope) => ({
      scope: compactElementProbe(scope),
      rows: pickerProbeRows(scope),
    }));
    const fingerprint = JSON.stringify(modelLike.map((entry) => ({
      role: entry.scope?.attrs?.role || '',
      text: entry.scope?.text || '',
      rows: entry.rows.map((row) => row.text || ''),
    })));
    if (!fingerprint || fingerprint === passivePickerFingerprint) return;
    passivePickerFingerprint = fingerprint;
    pointerTrace('passive_picker_snapshot', { reason, popups: modelLike });
  }

  function startPassivePickerObserver() {
    if (passivePickerObserver || !document.documentElement) return;
    passivePickerObserver = new MutationObserver((mutations) => {
      const startedAt = performance.now();
      // Full popup topology scans are diagnostic work, not ordinary runtime work.
      // Keep the observer dormant until an explicit verification transaction owns the page.
      if (autoVerificationRunning || cachedState?.autoVerification?.running === true) {
        passivePickerSnapshot('mutation');
      }
      recordMutationCost(mutations.length, startedAt);
    });
    passivePickerObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['role','aria-haspopup','aria-expanded','aria-controls','data-state','data-testid'],
    });
    passivePickerSnapshot('observer-start');
  }

  startPassivePickerObserver();

  // legacy-core-maintenance: diagnostic provenance for programmatic external-menu events only.\n  // Observation only: record menu-trigger clicks outside the active composer.
  // This gives the next diagnostic bundle provenance for the recent-chat "..." issue
  // without allowing the observer to click, close, or choose anything.
    function externalMenuProgrammaticTrace(event, trigger) {
    const target = compactElementProbe(trigger);
    const historyOptions = /^history-item-\d+-options$/i.test(String(trigger?.getAttribute?.('data-testid') || ''));
    const details = {
      isTrusted: event.isTrusted === true,
      href: location.href,
      eventType: event.type,
      x: Number.isFinite(event.clientX) ? event.clientX : null,
      y: Number.isFinite(event.clientY) ? event.clientY : null,
      target,
      historyOptions,
      autoProbeRunning,
      autoVerificationRunning: autoVerificationRunning || cachedState?.autoVerification?.running === true,
      lastAlignAttempt,
      lastAlignAt,
      pointerTraceSeq,
    };
    if (event.isTrusted !== true) {
      // Synthetic DOM events have no browser-generated call stack. Capture the
      // listener stack anyway so diagnostics can distinguish page dispatch from
      // GPTWork-owned execution, then correlate with the latest GPTWork pointer intent.
      try { details.listenerStack = String(new Error('GPTWork synthetic external menu event').stack || '').slice(0, 6000); } catch {}
      pointerTrace(historyOptions ? 'history_menu_programmatic_event' : 'external_menu_programmatic_event', details);
    }
    return details;
  }

document.addEventListener('pointerdown', (event) => {
    const trigger = event.target?.closest?.('button[aria-haspopup="menu"],[role="button"][aria-haspopup="menu"]');
    if (!trigger || trigger.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host')) return;
    const composer = activeComposerSurface();
    if (composer?.contains?.(trigger)) return;
    const programmatic = externalMenuProgrammaticTrace(event, trigger);
    pointerTrace('external_menu_trigger_pointerdown', {
      ...programmatic,
      href: location.href,
      button: Number.isFinite(event.button) ? event.button : null,
      x: Number.isFinite(event.clientX) ? event.clientX : null,
      y: Number.isFinite(event.clientY) ? event.clientY : null,
      target: compactElementProbe(trigger),
    });
  }, true);

  document.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('button[aria-haspopup="menu"],[role="button"][aria-haspopup="menu"]');
    if (!trigger || trigger.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host')) return;
    const composer = activeComposerSurface();
    if (composer?.contains?.(trigger)) return;
    const programmatic = externalMenuProgrammaticTrace(event, trigger);
    pointerTrace('external_menu_trigger_click', {
      ...programmatic,
      href: location.href,
      x: Number.isFinite(event.clientX) ? event.clientX : null,
      y: Number.isFinite(event.clientY) ? event.clientY : null,
      target: compactElementProbe(trigger),
    });
  }, true);

  function elementTexts(element) {
    return [
      element?.textContent?.trim(),
      element?.getAttribute?.('aria-label')?.trim(),
      element?.getAttribute?.('title')?.trim(),
    ].filter(Boolean);
  }

  function firstNormalized(selectors, normalize) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        for (const text of elementTexts(element)) {
          const value = normalize(text);
          if (value) return value;
        }
      }
    }
    return null;
  }

  function firstNormalizedElements(elements, normalize) {
    for (const element of elements) {
      for (const text of elementTexts(element)) {
        const value = normalize(text);
        if (value) return value;
      }
    }
    return null;
  }

  function composerNearbyControls() {
    const composer = COMPOSER_SELECTORS.map((selector) => document.querySelector(selector)).find((element) => element && visible(element));
    if (!composer) return [];
    const composerRect = composer.getBoundingClientRect();
    return [...document.querySelectorAll('button,[role="button"],[aria-haspopup]')].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom >= composerRect.top - 96 && rect.top <= composerRect.bottom + 96;
    });
  }

  function normalizeDisplayedModel(text) {
    if (!text) return null;
    const compact = text.trim().toLowerCase().replace(/\s+/g, '-');
    const explicit = compact.match(/gpt-?(\d+(?:\.\d+)*)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?/);
    if (explicit) {
      const suffix = explicit[2] ? `-${explicit[2]}` : '';
      const value = `gpt-${explicit[1]}${suffix}`;
      return value === 'gpt-5.6-sol-wm' ? 'gpt-5.6-sol' : value;
    }
    const compactSol = compact.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)*)-sol(?:-wm)?(?:-|$)/);
    if (compactSol) return `gpt-${compactSol[1]}-sol`;
    return null;
  }

  function normalizeDisplayedReasoning(text) {
    if (!text) return null;
    const value = text.trim().toLowerCase();
    if (/extra[\s_-]*high|xhigh|超高/.test(value)) return 'extra-high';
    if (/\bhigh\b|高级|高$/.test(value)) return 'high';
    if (/\bmedium\b|中级|中$/.test(value)) return 'medium';
    if (/\blow\b|低级|低$/.test(value)) return 'low';
    return null;
  }

  function collectObservation() {
    const validated = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.collect?.();
    if (validated) {
      return {
        model: validated.model || null,
        reasoning: validated.reasoning || null,
        evidenceSource: 'page_dom',
        modelEvidenceSource: validated.modelSource || 'none',
        reasoningEvidenceSource: validated.reasoningSource || 'none',
        modelLabel: validated.modelLabel || '',
        reasoningLabel: validated.reasoningLabel || '',
        ambiguousModel: Boolean(validated.ambiguous),
        candidates: Array.isArray(validated.candidates) ? validated.candidates.slice(0, 8) : [],
        capturedAt: new Date().toISOString(),
      };
    }

    const nearbyControls = composerNearbyControls();
    const model = firstNormalized(MODEL_SELECTORS, normalizeDisplayedModel)
      || firstNormalizedElements(nearbyControls, normalizeDisplayedModel)
      || firstNormalized(['button,[role="button"]'], normalizeDisplayedModel);
    const reasoning = firstNormalized(REASONING_SELECTORS, normalizeDisplayedReasoning)
      || firstNormalizedElements(nearbyControls, normalizeDisplayedReasoning)
      || firstNormalized(MODEL_SELECTORS, normalizeDisplayedReasoning)
      || (model ? firstNormalized(['button,[role="button"]'], normalizeDisplayedReasoning) : null);
    return {
      model,
      reasoning,
      evidenceSource: 'page_dom',
      modelEvidenceSource: 'legacy-fallback',
      reasoningEvidenceSource: 'legacy-fallback',
      ambiguousModel: false,
      candidates: model ? [model] : [],
      capturedAt: new Date().toISOString(),
    };
  }

  function runtimeContextAvailable() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            lastRuntimeContactAt = 0;
            reject(new Error(error.message));
          } else if (!response?.ok) {
            lastRuntimeContactAt = Date.now();
            reject(new Error(response?.error || 'Extension request failed'));
          } else {
            lastRuntimeContactAt = Date.now();
            resolve(response.data);
          }
        });
      } catch (error) {
        lastRuntimeContactAt = 0;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function reasonText(guard) {
    const messages = {
      waiting_for_response_metadata: '请求已锁定，正在等待响应确认 / Request locked; waiting for response metadata',
      page_selection_not_allowed: '页面选择与策略不同；正式请求仍会尝试锁定 / UI differs; the formal request will still be locked',
      page_selection_missing: '页面未暴露完整选择；网络请求锁仍已就绪 / UI selection is incomplete; network request lock remains ready',
      response_verification_disabled: '响应确认已关闭；请求锁定仍启用 / Response verification is off; request locking remains active',
      network_monitor_not_attached: '请求锁定器未连接；聊天不会因此被阻断 / Request lock is not attached; chat remains fail-open',
      native_core_offline: '本地核心离线；请求锁定仍由扩展尝试执行 / Native Core is offline; extension request locking remains active',
      metadata_missing: '响应确认元数据不完整；不会因此阻断聊天 / Response metadata is incomplete; chat remains available',
      model_missing: '响应未暴露可验证模型字段 / Response did not expose a verifiable model field',
      reasoning_missing: '响应未暴露可验证推理强度字段 / Response did not expose a verifiable reasoning field',
      model_not_allowed: '响应确认模型与锁定策略不一致 / Confirmed response model mismatches the lock policy',
      reasoning_not_allowed: '响应推理强度与策略不一致；仅告警 / Response reasoning mismatches policy; warning only',
      evidence_source_insufficient: '证据来源不足 / Evidence source is insufficient',
      evidence_stale: '响应证据已过期 / Response evidence is stale',
      gptlock_disabled: 'GPTWork 已关闭 / GPTWork is disabled',
      policy_mismatch: '响应元数据与策略不匹配 / Response metadata mismatches policy',
      verification_error: '响应确认发生错误；聊天保持可用 / Response verification failed; chat remains available',
    };
    return messages[guard?.reason] || guard?.reason || '请求锁定准备中 / Request lock is preparing';
  }

  function ensureIndicator() {
    if (indicator?.isConnected) return indicator;
    const host = document.createElement('div');
    host.id = 'gptlock-indicator-host';
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
.indicator-shell{display:block}
        button{border:1px solid rgba(15,23,42,.16);border-radius:999px;padding:7px 10px;
          color:#fff;background:#64748b;font:700 12px/1.2 system-ui,sans-serif;box-shadow:0 5px 18px rgba(15,23,42,.16);cursor:pointer}
        button[data-tone="good"]{background:#15803d} button[data-tone="bad"]{background:#b91c1c}
        button[data-tone="wait"]{background:#b45309} button[data-tone="lock"]{background:#2563eb}
        button:focus{outline:3px solid #bfdbfe}
        .model-verification-progress{width:220px;padding:7px 9px;border:1px solid #bfdbfe;border-radius:10px;
          background:rgba(239,246,255,.98);box-shadow:0 5px 18px rgba(15,23,42,.12);color:#1e3a8a;
          font:700 11px/1.35 system-ui,sans-serif}
        .model-verification-progress div{display:flex;justify-content:space-between;gap:8px;margin-bottom:5px}
        .model-verification-progress progress{display:block;width:100%;height:7px;accent-color:#2563eb}
      </style>
      <div class="indicator-shell"><button type="button" title="打开 GPTWork 设置 / Open GPTWork settings">GPTWork · 检查中</button></div>`;
    root.querySelector('button').addEventListener('click', () => {
      void sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }).catch(() => {});
    });
    document.documentElement.append(host);
    indicator = host;
    return host;
  }

  function positionVerificationProgressHost(host) {
    if (!host) return;
    const anchors = ['gptlock-model-indicator-host', 'gptlock-indicator-host']
      .map((id) => document.getElementById(id))
      .filter((element) => element && element !== host && visible(element));
    const top = anchors.reduce((value, element) => Math.min(value, element.getBoundingClientRect().top), window.innerHeight);
    const bottom = anchors.length ? Math.max(52, Math.ceil(window.innerHeight - top + 8)) : 52;
    host.style.bottom = `${bottom}px`;
  }

  function renderIndicator() {
    const host = ensureIndicator();
    const root = host.shadowRoot;
    const shell = root.querySelector('.indicator-shell');
    const button = root.querySelector('button');
    const guard = cachedState?.guard;
    const auto = cachedState?.autoVerification;
    if (auto?.running) {
      const catalog = auto.catalogVerification;
      const total = Math.max(0, Number(catalog?.total || auto.maxAttempts || 0));
      const completed = Math.min(total, Math.max(0, Number(catalog?.completed || 0)));
      let progressHost = document.getElementById('gptlock-verification-progress-host');
      if (!progressHost) {
        progressHost = document.createElement('div');
        progressHost.id = 'gptlock-verification-progress-host';
        progressHost.style.cssText = 'all:initial;position:fixed;right:12px;bottom:52px;z-index:2147483647';
        const progressRoot = progressHost.attachShadow({ mode: 'open' });
        progressRoot.innerHTML = '<style>.model-verification-progress{width:240px;padding:7px 9px;border:1px solid #bfdbfe;border-radius:10px;background:rgba(239,246,255,.98);box-shadow:0 5px 18px rgba(15,23,42,.12);color:#1e3a8a;font:700 11px/1.35 system-ui,sans-serif}.model-verification-progress div{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}.model-verification-progress .current{font-weight:600;color:#475569}.model-verification-progress progress{display:block;width:100%;height:7px;accent-color:#2563eb}</style><div class="model-verification-progress"><div class="current"><span></span></div><div><span>执行进度</span><strong class="execution"></strong></div><div><span>验证成功</span><strong class="verified"></strong></div><div><span>请求确认</span><strong class="requested"></strong></div><progress value="0" max="1"></progress></div>';
        document.documentElement.append(progressHost);
      }
      positionVerificationProgressHost(progressHost);
      const progress = progressHost.shadowRoot.querySelector('.model-verification-progress');
      const label = catalog?.currentLabel || catalog?.currentModel || '正在发现账户模型…';
      const verified = Math.max(0, Number(catalog?.verified || 0));
      const requestConfirmed = Math.max(0, Number(catalog?.requestConfirmed || 0));
      progress.querySelector('.current span').textContent = label;
      // The catalog intentionally grows after real turns. Make that explicit instead
      // of presenting a changing denominator as if verification restarted.
      progress.querySelector('.execution').textContent = total ? `${completed} 已执行 · ${total} 已发现` : '正在发现…';
      progress.querySelector('.verified').textContent = total ? `${verified} / ${total}` : '…';
      progress.querySelector('.requested').textContent = total ? `${requestConfirmed} / ${total}` : '…';
      const bar = progress.querySelector('progress');
      bar.max = Math.max(1, total);
      bar.value = completed;
      button.textContent = `GPTWork · 模型验证 · 已执行 ${completed} · 已发现 ${total}`;
      button.dataset.tone = 'wait';
      button.title = '模型验证正在进行；执行进度与验证成功分开统计。响应/流模型元数据优先用于验证，请求模型保留为请求确认。';
      return;
    }
    document.getElementById('gptlock-verification-progress-host')?.remove();
    const labels = {
      lock_ready: ['请求已锁', 'lock'],
      verified: ['已确认', 'good'],
      mismatch: [guard?.canSend ? '有告警' : '模型不符', guard?.canSend ? 'wait' : 'bad'],
      preflight_mismatch: ['页面不同', 'wait'],
      preflight_unknown: ['页面未知', 'wait'],
      waiting: ['等待确认', 'wait'],
      unverified: ['确认不足', 'wait'],
      error: ['确认错误', 'wait'],
      monitor_offline: ['锁定器离线', 'wait'],
      verification_disabled: ['仅请求锁', 'lock'],
      core_offline: ['核心离线', 'wait'],
      disabled: ['已关闭', 'off'],
    };
    const [label, tone] = labels[guard?.status] || ['检查中', 'wait'];
    button.textContent = `GPTWork · ${label}`;
    button.dataset.tone = tone;
    const verificationReason = auto?.outcome && auto.outcome !== 'verified'
      ? `模型验证已结束：${auto.reason || auto.outcome}；已验证 ${auto.catalogVerification?.verified || 0}/${auto.catalogVerification?.total || 0}。`
      : null;
    button.title = `${verificationReason || reasonText(guard)}\n点击打开设置 / Click to open settings`;
  }

  function showNotice(guard) {
    const existing = document.getElementById('gptlock-notice-host');
    existing?.remove();
    const host = document.createElement('div');
    host.id = 'gptlock-notice-host';
    host.style.cssText = 'all:initial;position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        div{max-width:min(560px,calc(100vw - 32px));padding:13px 16px;border:1px solid #fecaca;border-radius:13px;
          color:#7f1d1d;background:#fff7f7;box-shadow:0 12px 36px rgba(127,29,29,.2);font:600 13px/1.55 system-ui,sans-serif}
        strong{display:block;margin-bottom:2px;color:#991b1b;font-size:14px}
      </style>
      <div role="alert"><strong>GPTWork 已阻止发送 / Send blocked</strong><span></span></div>`;
    root.querySelector('span').textContent = reasonText(guard);
    document.documentElement.append(host);
    window.setTimeout(() => host.remove(), 6500);
  }

  function updateCache(payload) {
    if (payload?.state !== undefined) cachedState = payload.state;
    setAutoVerificationOwnership(cachedState?.autoVerification?.running === true);
    if (payload?.policy) cachedPolicy = payload.policy;
    if (payload?.settings) cachedSettings = payload.settings;
    renderIndicator();
    scheduleAlign();
  }

  function failOpenStaleRuntime() {
    cachedSettings = { ...(cachedSettings || {}), enabled: false };
    if (cachedState) {
      cachedState = {
        ...cachedState,
        phase: 'initial',
        guard: {
          ...(cachedState.guard || {}),
          canSend: true,
          allowKind: 'disabled',
          status: 'disabled',
          reason: 'gptlock_disabled',
        },
      };
    }
    document.getElementById('gptlock-notice-host')?.remove();
    indicator?.remove();
    indicator = null;
  }

  function locallyMarkSendStarted() {
    if (!cachedState?.guard || !cachedSettings?.networkVerificationEnabled) return;
    if (['disabled', 'outside_scope'].includes(cachedState.guard.allowKind)) return;
    cachedState = {
      ...cachedState,
      phase: 'waiting',
      guard: {
        ...cachedState.guard,
        canSend: true,
        allowKind: 'locked',
        status: 'waiting',
        reason: 'waiting_for_response_metadata',
      },
    };
    renderIndicator();
  }

  function handlePotentialSend(event) {
    if (event.type === 'submit' && Date.now() - sendConsumedAt < 750) return true;

    // During automatic model verification this fixed probe belongs exclusively to the
    // verification transaction. Normal Work/model-lock guards have no decision authority.
    if (cachedState?.autoVerification?.running === true) {
      sendConsumedAt = Date.now();
      void sendMessage({ type: 'GPTLOCK_SEND_STARTED' }).catch(() => {});
      return true;
    }

    // The page-level listener can outlive the extension service worker when a user
    // disables/reloads/uninstalls the extension. A stale listener must never keep
    // ChatGPT blocked after GPTWork itself is no longer reachable.
    if (cachedSettings?.enabled === false || !runtimeContextAvailable()) {
      failOpenStaleRuntime();
      return true;
    }

    const guard = cachedState?.guard;
    if (!guard) return true;
    if (!guard.canSend && Date.now() - lastRuntimeContactAt > BLOCKING_GUARD_MAX_AGE_MS) {
      failOpenStaleRuntime();
      return true;
    }
    if (!guard.canSend) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showNotice(guard);
      void sendMessage({
        type: 'GPTLOCK_SEND_BLOCKED',
        status: guard.status,
        reason: guard.reason,
      }).catch(() => failOpenStaleRuntime());
      return false;
    }
    sendConsumedAt = Date.now();
    locallyMarkSendStarted();
    void sendMessage({ type: 'GPTLOCK_SEND_STARTED' }).catch(() => failOpenStaleRuntime());
    return true;
  }

  function matchesAny(element, selectors) {
    return selectors.some((selector) => element?.closest?.(selector));
  }

  document.addEventListener('click', (event) => {
    if (matchesAny(event.target, SEND_SELECTORS)) handlePotentialSend(event);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter'
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing
      && matchesAny(event.target, COMPOSER_SELECTORS)
    ) {
      handlePotentialSend(event);
    }
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target?.querySelector?.(COMPOSER_SELECTORS.join(','))) handlePotentialSend(event);
  }, true);

  async function report() {
    const observation = collectObservation();
    const fingerprint = JSON.stringify([
      observation.model,
      observation.reasoning,
      observation.modelEvidenceSource,
      observation.reasoningEvidenceSource,
      observation.modelLabel,
      observation.reasoningLabel,
      observation.ambiguousModel,
      observation.candidates,
    ]);
    if (fingerprint === previousFingerprint) return;
    previousFingerprint = fingerprint;
    try {
      const state = await sendMessage({ type: 'GPTLOCK_PAGE_OBSERVATION', observation });
      updateCache({ state });
    } catch {
      // The service worker or native host may be unavailable during browser startup.
    }
  }

  function visible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // Radix keeps outgoing picker layers mounted while sliding them above/below the
    // viewport. A non-zero rect is therefore not sufficient evidence that a control
    // can receive trusted input. Require real viewport intersection so verification
    // never reuses an off-screen opener from the previous model turn.
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth;
  }

  function activeComposerSurface() {
    const composer = findComposer();
    if (!composer) return null;
    const form = composer.closest?.('form');
    if (form && visible(form)) return form;
    const testRoot = composer.closest?.('[data-testid*="composer"]');
    if (testRoot && visible(testRoot)) return testRoot;
    return composer.parentElement || null;
  }

  function composerControlRegion() {
    // One ownership boundary for every model action: start from the active composer
    // and expand only through its own form / composer container. Never search the page.
    const surface = activeComposerSurface();
    if (!surface) return null;
    return surface.closest?.('form')
      || surface.closest?.('[data-testid*="composer"]')
      || surface;
  }

  function composerIntelligenceTrigger() {
    // Single authority: first bind execution to the active composer, then select the
    // one text-bearing menu control inside that owner. The attachment "+" control is
    // also aria-haspopup=menu but has no visible value; page/sidebar menus are outside
    // this ownership boundary and therefore never enter the executable candidate set.
    const root = composerControlRegion();
    if (!root) return null;
    const menuTriggers = [...root.querySelectorAll('button[aria-haspopup="menu"],[role="button"][aria-haspopup="menu"]')]
      .filter((element) => element && visible(element) && !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'));
    const valueBearing = menuTriggers.filter((element) =>
      String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().length > 0
    );
    if (valueBearing.length === 1) return valueBearing[0];
    return null;
  }

  function stayInChatModeButton() {
    const labels = [
      /留在聊天模式/,
      /stay in chat mode/i,
      /continue in chat/i,
    ];
    const candidates = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    return candidates.find((element) => labels.some((pattern) => pattern.test(normalizedPickerLabel(element)))) || null;
  }

  async function dismissWorkContinuationPrompt() {
    const stay = stayInChatModeButton();
    if (!stay) return false;
    // This is an explicit product prompt action, not model-picker discovery.
    await trustedPointer(stay, 'click', 'work-continuation');
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return true;
  }

  function modelTrigger(triggerSelectors = MODEL_SELECTORS) {
    if (triggerSelectors !== MODEL_SELECTORS) {
      return triggerSelectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element && visible(element)) || null;
    }
    return composerIntelligenceTrigger();
  }

  function menuCandidates(scope = null) {
    // Never expose arbitrary page menus to model automation. In particular, the
    // recent-conversation action menu is a Radix [role=menu] with Share/Rename/Delete
    // and is structurally indistinguishable from a generic menu if searched globally.
    const safeScope = scope || visibleIntelligencePickerContent();
    if (!safeScope) return [];
    return verifiedModelRows(safeScope);
  }

  function elementCenter(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + Math.max(1, rect.width / 2),
      y: rect.top + Math.max(1, rect.height / 2),
    };
  }

  function dispatchSyntheticPointer(element, action = 'click') {
    const point = elementCenter(element);
    if (!point) return false;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
    };
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    if (action === 'move') {
      for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
        try { element.dispatchEvent(new PointerCtor(type, { ...common, pointerType: 'mouse', isPrimary: true })); } catch {}
      }
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        try { element.dispatchEvent(new MouseEvent(type, common)); } catch {}
      }
      return true;
    }
    try { element.dispatchEvent(new PointerCtor('pointerover', { ...common, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerup', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('click', { ...common, button: 0, buttons: 0, detail: 1 })); } catch {}
    return true;
  }

  function pointerStillOwnsPoint(element, point) {
    if (!element?.isConnected || !point) return false;
    const hit = document.elementFromPoint(point.x, point.y);
    return Boolean(hit && (hit === element || element.contains?.(hit)));
  }

  function pointerOwnedVisiblePoint(element) {
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

  async function modelPickerPointer(element, action = 'click', source = 'model-picker') {
    // chrome.debugger's infobar, picker animations, and compositor movement can make
    // an otherwise correct owned row briefly fail the center-point hit test. Retry
    // the SAME DOM element only; never fall back to a global/coordinate candidate.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dispatched = await trustedPointer(element, action, `${source}:attempt-${attempt}`);
      if (dispatched) {
        // ChatGPT's picker is animated and this browser can be under sustained UI load.
        // Treat every picker click as a transition boundary: give the page a full two
        // seconds to settle before reading/reusing any downstream picker element.
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        return true;
      }
      if (!element?.isConnected || !visible(element)) return false;
      await new Promise((resolve) => window.setTimeout(resolve, 160 * attempt));
    }
    return false;
  }

  async function trustedPointer(element, action = 'click', source = 'unspecified') {
    const traceId = ++pointerTraceSeq;
    if (!element || !visible(element)) {
      pointerTrace('rejected_invisible', { traceId, action, source, target: compactElementProbe(element) });
      return false;
    }
    pointerTrace('intent', {
      traceId, action, source, href: location.href,
      target: compactElementProbe(element),
      composerRoot: compactElementProbe(activeComposerSurface()),
    });
    try { element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
    try { element.focus?.({ preventScroll: true }); } catch {}
    try {
      // Attaching chrome.debugger can show Chrome's debugging infobar and move the
      // entire viewport. Never compute coordinates until that layout change is over.
      await sendMessage({ type: 'GPTLOCK_TRUSTED_POINTER_PREPARE' });
      // chrome.debugger's infobar and Radix slider transitions can both move the picker.
      // Wait for the exact owned element to stop moving AND own its center before dispatch.
      // This is a readiness barrier, not a second selector/authority path.
      let point = null;
      let previousPoint = null;
      let stableFrames = 0;
      const ready = await waitUntil(() => {
        if (!element.isConnected || !visible(element)) return null;
        const nextPoint = pointerOwnedVisiblePoint(element);
        if (!nextPoint) {
          previousPoint = null;
          stableFrames = 0;
          return null;
        }
        const stable = previousPoint
          && Math.abs(nextPoint.x - previousPoint.x) < 1
          && Math.abs(nextPoint.y - previousPoint.y) < 1;
        previousPoint = nextPoint;
        stableFrames = stable ? stableFrames + 1 : 0;
        if (stableFrames < 2) return null;
        point = nextPoint;
        return nextPoint;
      }, 1800, 80);
      if (!ready || !point) {
        const fallbackPoint = element.isConnected && visible(element) ? pointerOwnedVisiblePoint(element) : null;
        pointerTrace('rejected_unstable_hit_test', {
          traceId, action, source, point: fallbackPoint,
          target: compactElementProbe(element),
          hit: compactElementProbe(fallbackPoint ? document.elementFromPoint(fallbackPoint.x, fallbackPoint.y) : null),
        });
        return false;
      }
      const hit = document.elementFromPoint(point.x, point.y);
      await sendMessage({ type: 'GPTLOCK_TRUSTED_POINTER', action, x: point.x, y: point.y, traceId, source, target: compactElementProbe(element), hit: compactElementProbe(hit) });
      pointerTrace('dispatched', { traceId, action, source, point, target: compactElementProbe(element), hit: compactElementProbe(hit) });
      return true;
    } catch {
      // Synthetic fallback keeps the same DOM element as the sole action authority.
      // It never falls back to coordinates, global menus, or another candidate.
      if (!element.isConnected || !visible(element)) return false;
      const point = pointerOwnedVisiblePoint(element);
      if (!point || !pointerStillOwnsPoint(element, point)) {
        pointerTrace('fallback_rejected_hit_test', { traceId, action, source, point, target: compactElementProbe(element), hit: compactElementProbe(document.elementFromPoint(point?.x || 0, point?.y || 0)) });
        return false;
      }
      pointerTrace('synthetic_fallback', { traceId, action, source, point, target: compactElementProbe(element) });
      return dispatchSyntheticPointer(element, action);
    }
  }

  function visibleIntelligencePickerContent() {
    return [...document.querySelectorAll('[data-testid="composer-intelligence-picker-content"]')]
      .find((element) => visible(element)) || null;
  }

  function popupOwnedByTrigger(trigger, beforeScopes = new Set()) {
    if (!trigger) return null;
    const controlledId = trigger.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlled && visible(controlled)) return controlled;

    const triggerId = trigger.id || '';
    if (triggerId) {
      const labelled = modelPopupScopes().find((scope) =>
        scope.getAttribute?.('aria-labelledby') === triggerId
      );
      if (labelled) return labelled;
    }

    // Causal ownership is the fallback authority: only a popup that became visible
    // after this exact composer trigger was activated can belong to this transaction.
    const newlyVisible = modelPopupScopes().filter((scope) => !beforeScopes.has(scope));
    return newlyVisible.length === 1 ? newlyVisible[0] : null;
  }

  function verifiedModelRows(scope) {
    const rows = [...(scope?.querySelectorAll?.(
      '[role="menuitemradio"],[role="radio"],[role="option"],[role="menuitem"],button,[role="button"],[data-radix-collection-item],[data-model],[data-model-id],[data-testid^="model-switcher-"]'
    ) || [])].filter(visible);
    return [...new Set(rows)].filter((row) => {
      const descriptor = rowModelDescriptor(row);
      const signal = descriptor.values.join(' ');
      // Reasoning rows can repeat the active model name (for example
      // "GPT-5.6 Luna 高"). They are not additional account models. Require
      // explicit model metadata for any row that also carries a reasoning label.
      const reasoningDecorated = Boolean(normalizeDisplayedReasoning(descriptor.label));
      if (reasoningDecorated && !descriptor.explicitModelId) return false;
      return Boolean(
        descriptor.model
        || descriptor.rawId
        || /^model-switcher-gpt-/i.test(String(row.getAttribute?.('data-testid') || ''))
        || /\bgpt[-\s]?\d/i.test(signal)
      );
    });
  }

  function distinctModelRows(scope) {
    const unique = new Map();
    for (const row of verifiedModelRows(scope)) {
      const descriptor = rowModelDescriptor(row);
      const key = descriptor.model || descriptor.rawId || String(descriptor.label || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || unique.has(key)) continue;
      unique.set(key, row);
    }
    return [...unique.values()];
  }

  function normalizedPickerLabel(element) {
    return String([
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      element?.innerText,
      element?.textContent,
    ].filter(Boolean).join(' ')).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function advancedPickerView(picker) {
    return picker?.querySelector?.('[data-testid="composer-model-picker-slider-advanced-view"]') || null;
  }

  function advancedPickerToggle(picker) {
    return [...(picker?.querySelectorAll?.('[role="menuitem"],button,[role="button"]') || [])].filter(visible)
      .find((element) => /advanced|高级|進階|고급|avanzad|erweitert/i.test(normalizedPickerLabel(element))) || null;
  }

  function isModelListScope(scope) {
    if (!scope || !visible(scope)) return false;
    // The composer intelligence picker can expose two model-labelled rows while it is
    // still the second layer. Those rows are navigation/summary controls, not the
    // authoritative final account model catalog.
    if (scope.matches?.('[data-testid="composer-intelligence-picker-content"]')) return false;
    const rows = distinctModelRows(scope);
    if (rows.length < 2) return false;
    const label = normalizedPickerLabel(scope);
    return /select model|choose model|选择模型|選擇模型|모델 선택|modelo|modello|modèle/i.test(label)
      || rows.length >= 2;
  }

  function modelPopupScopes() {
    return [...document.querySelectorAll(
      '[role="menu"],[role="listbox"],[role="dialog"],[data-radix-menu-content],[data-radix-popper-content-wrapper]'
    )].filter(visible);
  }

  function modelSubmenuOpener(picker) {
    if (!picker) return null;
    // v0.5.90 diagnostics captured the current ChatGPT contract: the third-layer
    // catalog is owned by one menuitem whose accessible name is Select model.
    // Model-labelled rows are previews, never opener candidates.
    const rows = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => visible(element) && !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'));
    const openers = rows.filter((element) =>
      /^(select model|choose model|选择模型|選擇模型|모델 선택)$/i.test(
        String(element.getAttribute?.('aria-label') || element.getAttribute?.('title') || '').trim()
      )
    );
    return openers.length === 1 ? openers[0] : null;
  }

  function visibleModelSubmenu(picker, opener, beforeScopes = new Set()) {
    // Current ChatGPT may slide the authoritative catalog into the SAME owned
    // composer-intelligence picker instead of creating a third portal. That in-place
    // advanced view is valid only after the exact Select model opener was activated.
    const inPlaceCatalog = advancedPickerView(picker);
    if (inPlaceCatalog && visible(inPlaceCatalog) && distinctModelRows(inPlaceCatalog).length >= 2) {
      return inPlaceCatalog;
    }

    const controlledId = opener?.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlled && isModelListScope(controlled)) return controlled;

    const openerId = opener?.id || '';
    if (openerId) {
      const labelled = modelPopupScopes().find((menu) =>
        menu.getAttribute?.('aria-labelledby') === openerId && isModelListScope(menu)
      );
      if (labelled) return labelled;
    }

    // ChatGPT's current three-stage picker portals the final "Select model" menu.
    // Ownership is causal: it must be a model-list popup that became visible only
    // after clicking the unique model/reasoning row in the composer picker.
    const newlyVisible = modelPopupScopes()
      .filter((scope) => !beforeScopes.has(scope) && scope !== picker && !picker?.contains?.(scope))
      .filter(isModelListScope)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });
    return newlyVisible[0] || null;
  }

  function verificationPageContext() {
    return /^\/c\/[^/]+/.test(location.pathname) ? 'existing_chat' : 'new_chat';
  }

  async function openModernModelMenu() {
    await dismissWorkContinuationPrompt();
    const pageContext = verificationPageContext();
    const trigger = composerIntelligenceTrigger();
    pickerTopologyProbe('before-open');
    if (!trigger) return { trigger: null, picker: null, opener: null, submenu: null, rows: [] };

    const beforeTriggerScopes = new Set(modelPopupScopes());
    let picker = popupOwnedByTrigger(trigger, beforeTriggerScopes);
    if (!picker) {
      const opened = await modelPickerPointer(trigger, 'click', 'model-picker-trigger');
      if (!opened) return { trigger, picker: null, opener: null, submenu: null, rows: [] };
      picker = await waitUntil(() => popupOwnedByTrigger(trigger, beforeTriggerScopes), 2200, 80);
      pickerTopologyProbe('after-trigger-click', { ownedPicker: compactElementProbe(picker) });
    }
    if (!picker) return { trigger, picker: null, opener: null, submenu: null, rows: [], pageContext };

    // Picker topology is a runtime capability, not a URL property. ChatGPT can
    // switch the same / or /c/:id composer between:
    // A = simple direct list (currently Sol + 5.5, "思考强度")
    // B = intelligence slider/advanced picker with a nested account model catalog.
    // Detect the structure that is actually open so a verification turn may migrate
    // A -> B or B -> A without treating reasoning controls as model rows.
    const initialOpener = modelSubmenuOpener(picker);
    const initialAdvanced = advancedPickerToggle(picker);
    if (!initialOpener && !initialAdvanced) {
      const directRows = distinctModelRows(picker);
      if (directRows.length >= 2) {
        pickerTopologyProbe('picker-mode-a-direct-model-list', {
          pageContext,
          pickerMode: 'A',
          ownedPicker: compactElementProbe(picker),
          modelRows: directRows.map((row) => ({ element: compactElementProbe(row), descriptor: rowModelDescriptor(row) })),
        });
        return { trigger, picker, opener: null, submenu: picker, rows: directRows, pageContext, pickerMode: 'A' };
      }
    }

    // Discovery may leave ChatGPT's advanced picker view visibly mounted while
    // Escape is still animating/closing the outer Radix menu. Reusing that owned,
    // already-visible model list is safer than clicking the second-layer opener again:
    // the latter can move under the pointer during the view transition and fail the
    // stable hit-test before verification ever reaches the actual model row.
    const alreadyVisibleAdvanced = advancedPickerView(picker);
    const pickerIsOpen = picker?.getAttribute?.('data-state') !== 'closed'
      && picker?.closest?.('[data-state="closed"][role="menu"]') == null;
    const alreadyVisibleRows = pickerIsOpen && alreadyVisibleAdvanced ? distinctModelRows(alreadyVisibleAdvanced) : [];
    if (alreadyVisibleRows.length) {
      pickerTopologyProbe('third-layer-reused', {
        pageContext,
        opener: compactElementProbe(initialOpener),
        submenu: compactElementProbe(alreadyVisibleAdvanced),
        modelRows: alreadyVisibleRows.map((row) => ({ element: compactElementProbe(row), descriptor: rowModelDescriptor(row) })),
      });
      return { trigger, picker, opener: initialOpener, submenu: alreadyVisibleAdvanced, rows: alreadyVisibleRows, pageContext, pickerMode: 'B' };
    }

    if (!initialOpener) {
      const advanced = advancedPickerToggle(picker);
      if (advanced) {
        await modelPickerPointer(advanced, 'click', 'model-picker-advanced');
        await waitUntil(() => advancedPickerView(picker), 1400, 80);
      }
    }

    const opener = modelSubmenuOpener(picker);
    pickerTopologyProbe('second-layer-ready', { opener: compactElementProbe(opener) });
    if (!opener) return { trigger, picker, opener: null, submenu: null, rows: [] };

    // Single ownership chain: the final model list does not exist for GPTWork until
    // this exact second-layer row is activated. No pre-existing/global menu can win.
    const beforeScopes = new Set(modelPopupScopes());
    const opened = await modelPickerPointer(opener, 'click', 'model-picker-submenu');
    if (!opened) return { trigger, picker, opener, submenu: null, rows: [] };
    const submenu = await waitUntil(
      () => visibleModelSubmenu(picker, opener, beforeScopes),
      2400,
      80,
    );
    const rows = submenu ? distinctModelRows(submenu) : [];
    pickerTopologyProbe('third-layer-ready', {
      opener: compactElementProbe(opener),
      submenu: compactElementProbe(submenu),
      modelRows: rows.map((row) => ({ element: compactElementProbe(row), descriptor: rowModelDescriptor(row) })),
    });
    return { trigger, picker, opener, submenu, rows, pageContext, pickerMode: 'B' };
  }

  function rowModelDescriptor(row) {
    const evidence = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
    const testId = String(row?.getAttribute?.('data-testid') || '').trim();
    const testIdModel = testId.match(/^model-switcher-(gpt-[a-z0-9._:-]+)$/i)?.[1] || null;
    const dataValue = String(row?.getAttribute?.('data-value') || '').trim();
    const attributes = [
      row?.getAttribute?.('data-model'),
      row?.getAttribute?.('data-model-id'),
      dataValue,
      testIdModel,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const values = [
      ...attributes,
      row?.getAttribute?.('aria-label'),
      row?.getAttribute?.('title'),
      row?.innerText,
      row?.textContent,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const explicitModelId = attributes.find((value) => /^[a-z0-9._:-]{2,128}$/i.test(value) && /gpt/i.test(value)) || null;
    const rawId = explicitModelId
      || values.find((value) => /^[a-z0-9._:-]{2,128}$/i.test(value) && /gpt/i.test(value))
      || null;
    const model = values.map((value) => normalizeDisplayedModel(value)).find(Boolean)
      || values.map((value) => evidence?.modelFromText?.(value)).find(Boolean)
      || rawId;
    const label = values.find((value) => /gpt|astra|sol|thinking|latest|最新|최신|pro|terra|luna/i.test(value))
      || values.find(Boolean)
      || model
      || rawId
      || '';
    const selectorKey = testId
      || dataValue
      || String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return { rawId, model, label, selectorKey, values, explicitModelId };
  }

  async function closeModelMenus(trigger = null) {
    // Close is idempotent and never toggles the opener. Escape owns dismissal;
    // a closed trigger must never be clicked as cleanup.
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 90));
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    if (visibleIntelligencePickerContent()) {
      pointerTrace('picker_close_incomplete', { source: 'escape-only', trigger: compactElementProbe(trigger) });
    }
  }

  async function chooseModelExact({ model = null, selectorKey = '', label = '' } = {}) {
    const desired = normalizeDisplayedModel(model) || String(model || '').trim().toLowerCase() || null;
    const wantedKey = String(selectorKey || '').trim().toLowerCase();
    const wantedLabel = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const modern = await openModernModelMenu();
    if (modern.rows.length) {
      const candidate = modern.rows.find((row) => {
        const descriptor = rowModelDescriptor(row);
        if (desired && (descriptor.model === desired || descriptor.rawId === desired)) return true;
        if (wantedKey && String(descriptor.selectorKey || '').toLowerCase() === wantedKey) return true;
        return Boolean(wantedLabel && String(descriptor.label || '').toLowerCase().replace(/\s+/g, ' ') === wantedLabel);
      });
      if (candidate) {
        await trustedPointer(candidate, 'click');
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (!desired) return true;
        const confirmed = await waitUntil(() => collectObservation().model === desired, 3000, 100);
        if (confirmed) return true;
      }
      await closeModelMenus(modern.trigger);
    }
    if (!desired) return false;
    return chooseExact(MODEL_SELECTORS, desired, normalizeDisplayedModel, { skipModern: true });
  }

  async function selectModelForVerification({ model = null, selectorKey = '', label = '' } = {}) {
    const desired = normalizeDisplayedModel(model) || String(model || '').trim().toLowerCase() || null;
    const wantedKey = String(selectorKey || '').trim().toLowerCase();
    const wantedLabel = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const modern = await openModernModelMenu();

    if (modern.rows.length) {
      const candidate = modern.rows.find((row) => {
        const descriptor = rowModelDescriptor(row);
        if (desired && (descriptor.model === desired || descriptor.rawId === desired)) return true;
        if (wantedKey && String(descriptor.selectorKey || '').toLowerCase() === wantedKey) return true;
        return Boolean(wantedLabel && String(descriptor.label || '').toLowerCase().replace(/\s+/g, ' ') === wantedLabel);
      });
      if (!candidate) {
        await closeModelMenus(modern.trigger);
        return { attempted: false, observation: collectObservation() };
      }
      // The catalog row may already be the active model (especially the default model
      // on a fresh new-chat page). Treat the owned checked radio as a real selection
      // acknowledgement instead of requiring a no-op click to dispatch.
      if (candidate.getAttribute('data-state') === 'checked') {
        const observation = collectObservation();
        pointerTrace('verification_model_selection_confirmed', {
          source: 'verification-model-row-already-checked', desired, selectorKey: wantedKey, label: wantedLabel,
          observation,
        });
        return { attempted: true, observation };
      }
      const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row');
      if (!attempted) return { attempted: false, observation: collectObservation() };
      // Never keep using the pre-click row as a liveness authority. Radix replaces or
      // collapses picker nodes during the transition; after the mandatory settle delay,
      // re-open/reacquire on any later verification step instead of timing out on a stale
      // zero-sized element.
      // A dispatched click is not a completed model selection. Wait until ChatGPT's
      // Composer reflects the requested model before allowing the probe transaction.
      const confirmed = desired
        ? await waitUntil(() => {
            // In the new-chat Composer ChatGPT can intentionally hide the model label
            // after a successful row click and leave only the reasoning control visible.
            // The exact owned catalog row's radio state is therefore the primary UI
            // acknowledgement; Composer model text remains a secondary read-only signal.
            if (candidate.isConnected && candidate.getAttribute('data-state') === 'checked') return true;
            return collectObservation().model === desired;
          }, 3500, 100)
        : await waitUntil(() => !visible(candidate) || !visibleIntelligencePickerContent(), 1800, 100);
      const observation = collectObservation();
      pointerTrace(confirmed ? 'verification_model_selection_confirmed' : 'verification_model_selection_unconfirmed', {
        source: 'verification-model-row', desired, selectorKey: wantedKey, label: wantedLabel,
        observation,
      });
      if (!confirmed) {
        await closeModelMenus(modern.trigger);
        return { attempted: false, observation };
      }
      return { attempted: true, observation };
    }

    await closeModelMenus(modern.trigger);
    return { attempted: false, observation: collectObservation() };
  }

  async function chooseExact(triggerSelectors, desired, normalize, { skipModern = false } = {}) {
    if (triggerSelectors === MODEL_SELECTORS) {
      if (!skipModern) return chooseModelExact({ model: desired, label: desired });
      // There is deliberately no generic legacy fallback for model selection.
      // A failed modern picker lookup must fail closed rather than clicking another
      // visible Radix menu such as the recent-chat "..." action menu.
      return false;
    }
    const trigger = modelTrigger(triggerSelectors);
    if (!trigger) return false;
    const current = elementTexts(trigger).map(normalize).find(Boolean);
    if (current === desired) return true;
    await trustedPointer(trigger, 'click');
    const controlledId = trigger.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    const candidates = await waitUntil(() => {
      const scope = controlled && visible(controlled) ? controlled : null;
      const rows = scope
        ? [...scope.querySelectorAll('[role="menuitemradio"],[role="radio"],[role="option"]')].filter(visible)
        : [];
      return rows.length ? rows : null;
    }, 2500, 80);
    const candidate = (candidates || []).find((element) => {
      const values = [
        element.getAttribute?.('data-model'),
        element.getAttribute?.('data-model-id'),
        element.getAttribute?.('data-value'),
        element.getAttribute?.('data-testid'),
        ...elementTexts(element),
      ].filter(Boolean);
      return values.some((text) => normalize(text) === desired);
    });
    if (!candidate) {
      await trustedPointer(trigger, 'click');
      return false;
    }
    await trustedPointer(candidate, 'click');
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    return true;
  }

  async function alignSelection({ force = false } = {}) {
    // Verification owns the model UI for its entire transaction. Background alignment
    // is suspended instead of becoming a second model-selection authority.
    if (cachedState?.autoVerification?.running) return false;
    if (!cachedSettings?.enabled || !cachedSettings.autoAlignSelection || !cachedPolicy || visibleGeneratingControl()) return false;
    const observation = collectObservation();
    const desiredModel = cachedPolicy.lockedModels?.[0];
    const knownModels = new Set(Array.isArray(cachedState?.knownModels) ? cachedState.knownModels : []);
    const pageModelIsKnown = Boolean(observation.model && knownModels.has(observation.model));
    const preferred = cachedPolicy.allowedReasoningLevels?.includes(cachedSettings.preferredReasoning)
      ? cachedSettings.preferredReasoning
      : cachedPolicy.allowedReasoningLevels?.[0];
    const signature = JSON.stringify([location.pathname, desiredModel, preferred, observation.model, observation.reasoning, force]);
    if (!force && signature === lastAlignAttempt && Date.now() - lastAlignAt < 30000) return false;
    lastAlignAttempt = signature;
    lastAlignAt = Date.now();

    let changed = false;
    if (desiredModel && observation.model && !pageModelIsKnown && observation.model !== desiredModel) {
      changed = await chooseExact(MODEL_SELECTORS, desiredModel, normalizeDisplayedModel);
    }
    const afterModel = changed ? collectObservation() : observation;
    if (preferred && !changed && afterModel.reasoning && afterModel.reasoning !== preferred) {
      changed = await chooseExact(REASONING_SELECTORS, preferred, normalizeDisplayedReasoning);
    }
    if (changed) window.setTimeout(() => void report(), 700);
    return changed;
  }

  function scheduleAlign() {
    clearTimeout(alignTimer);
    alignTimer = window.setTimeout(() => void alignSelection(), 900);
  }

  function scheduleReport() {
    clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        previousFingerprint = '';
        void sendMessage({ type: 'GPTLOCK_CONTEXT_CHANGED', url: lastUrl })
          .then((state) => updateCache({ state }))
          .catch(() => {});
      }
      void report();
      scheduleAlign();
    }, 900);
  }

  function findComposer() {
    return COMPOSER_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element)) || null;
  }

  function composerText(composer) {
    if (!composer) return '';
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value || '';
    return composer.innerText || composer.textContent || '';
  }

  function dispatchComposerInput(composer, text) {
    try {
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }));
    } catch {
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerText(composer, text) {
    if (composer instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor?.set?.call(composer, text);
      dispatchComposerInput(composer, text);
      return;
    }
    if (composer instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(composer, text);
      dispatchComposerInput(composer, text);
      return;
    }

    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      composer.textContent = text;
      dispatchComposerInput(composer, text);
    }
  }

  function findSendButton() {
    return SEND_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true') || null;
  }

  async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }
    return null;
  }

  function idleSnapshot() {
    const generatingControl = visibleGeneratingControl();
    const composer = findComposer();
    const sendButton = findSendButton();
    const assistant = assistantMessages().at(-1) || null;
    const text = String(assistant?.innerText || assistant?.textContent || '').trim();
    return {
      generating: Boolean(generatingControl),
      generatingLabel: String(generatingControl?.getAttribute?.('aria-label') || generatingControl?.getAttribute?.('title') || generatingControl?.textContent || '').trim().slice(0, 160),
      composerVisible: Boolean(composer && visible(composer)),
      sendReady: Boolean(sendButton),
      assistantCount: assistantMessages().length,
      assistantFingerprint: `${text.length}:${text.slice(-120)}`,
    };
  }

  async function waitForIdle() {
    const deadline = Date.now() + 30000;
    let stableSince = 0;
    let lastFingerprint = '';
    while (Date.now() < deadline) {
      const snapshot = idleSnapshot();
      // Current ChatGPT can leave a stale visible Stop control mounted after the
      // response has terminally settled. A ready composer + stable assistant turn
      // for 1.5s is a safe secondary terminal signal; it never treats changing
      // assistant text as idle.
      if (!snapshot.generating) return snapshot;
      const fingerprint = `${snapshot.assistantCount}:${snapshot.assistantFingerprint}`;
      if (snapshot.composerVisible && snapshot.sendReady) {
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          stableSince = Date.now();
        } else if (stableSince && Date.now() - stableSince >= 1500) {
          return { ...snapshot, staleGeneratingControlIgnored: true };
        }
      } else {
        stableSince = 0;
        lastFingerprint = fingerprint;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    const snapshot = idleSnapshot();
    throw new Error(`ChatGPT is still generating / ChatGPT 仍在生成回复 [${JSON.stringify(snapshot)}]`);
  }

  function verificationWorkControl() {
    return [...document.querySelectorAll('button,[role="tab"],[role="button"]')].find((element) => {
      if (!visible(element)) return false;
      if (!VERIFICATION_WORK_LABEL.test(String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.top < 120 && rect.width > 24 && rect.width < 240;
    }) || null;
  }

  async function enterVerificationWorkMode() {
    await waitForIdle();
    const control = verificationWorkControl();
    if (!control) return { attempted: false, reason: 'work_control_not_found' };
    const selected = control.getAttribute('aria-selected') === 'true'
      || control.getAttribute('aria-pressed') === 'true'
      || ['checked', 'selected', 'active'].includes(String(control.getAttribute('data-state') || '').toLowerCase());
    if (selected) return { attempted: false, alreadySelected: true, reason: 'already_work' };
    await trustedPointer(control, 'click', 'verification-work-mode');
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    return { attempted: true, reason: 'work_control_clicked' };
  }

  async function stopStaleGeneration() {
    const control = visibleGeneratingControl();
    if (!control) return { stopped: false, alreadyIdle: true };
    await trustedPointer(control, 'click', 'verification-stale-generation-stop');
    const idle = await waitUntil(() => !visibleGeneratingControl(), 5000, 100);
    return { stopped: true, idle: Boolean(idle) };
  }

  async function waitForProbeTurnSettled(message = {}) {
    const before = Math.max(0, Number(message.assistantCountBefore || 0));
    const timeoutMs = Math.min(180000, Math.max(5000, Number(message.timeoutMs || 120000)));
    const deadline = Date.now() + timeoutMs;
    let sawActivity = Boolean(visibleGeneratingControl()) || assistantMessages().length > before;
    let idleSince = 0;
    let stableFingerprint = '';
    while (Date.now() < deadline) {
      const generating = Boolean(visibleGeneratingControl());
      const messages = assistantMessages();
      if (generating || messages.length > before) sawActivity = true;
      if (!sawActivity || generating) {
        idleSince = 0;
        stableFingerprint = '';
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        continue;
      }
      const last = messages.at(-1);
      const text = String(last?.innerText || last?.textContent || '').trim();
      const fingerprint = `${messages.length}:${text.length}:${text.slice(-120)}`;
      if (fingerprint !== stableFingerprint) {
        stableFingerprint = fingerprint;
        idleSince = Date.now();
      } else if (idleSince && Date.now() - idleSince >= 1200) {
        return { settled: true, assistantCount: messages.length, responseTextLength: text.length };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return { settled: false, stillGenerating: Boolean(visibleGeneratingControl()), assistantCount: assistantMessages().length };
  }

  async function autoSendProbe(options = {}) {
    if (autoProbeRunning) throw new Error('Automatic verification is already running / 自动验证正在进行');
    autoProbeRunning = true;
    try {
      await waitForIdle();
      const assistantCountBefore = assistantMessages().length;
      if (options.skipAlignment !== true) {
        await alignSelection({ force: true });
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }

      const composer = await waitUntil(findComposer, 5000, 100);
      if (!composer) throw new Error('ChatGPT composer not found / 未找到 ChatGPT 输入框');
      const originalDraft = composerText(composer);
      const draftPreserved = Boolean(originalDraft.trim());
      const probeText = typeof options.probeText === 'string' && options.probeText.trim()
        ? options.probeText.trim().slice(0, 500)
        : AUTO_PROBE_TEXT;
      const probeMarker = typeof options.probeMarker === 'string' && options.probeMarker.trim()
        ? options.probeMarker.trim().slice(0, 120)
        : 'GPTWork 自动验证';

      setComposerText(composer, probeText);
      const filled = await waitUntil(() => composerText(composer).includes(probeMarker), 2500, 80);
      if (!filled) throw new Error('Failed to write visible test message / 无法写入可见测试消息');

      const sendButton = await waitUntil(findSendButton, 5000, 100);
      if (!sendButton) {
        if (draftPreserved) setComposerText(composer, originalDraft);
        throw new Error('ChatGPT send button is unavailable / ChatGPT 发送按钮不可用');
      }
      await trustedPointer(sendButton, 'click', 'auto-probe-send');

      const sent = await waitUntil(() => {
        const currentComposer = findComposer();
        const current = composerText(currentComposer);
        return !current.includes(probeMarker) || Boolean(visibleGeneratingControl());
      }, 5000, 100);
      if (!sent) {
        if (draftPreserved) setComposerText(composer, originalDraft);
        throw new Error('Visible test message was not accepted by ChatGPT / 可见测试消息未被 ChatGPT 接收');
      }

      let draftRestored = false;
      if (draftPreserved) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const restoreComposer = await waitUntil(findComposer, 3000, 100);
        if (restoreComposer) {
          setComposerText(restoreComposer, originalDraft);
          draftRestored = composerText(restoreComposer).trim() === originalDraft.trim();
        }
      }
      return {
        sent: true,
        method: 'visible_composer_click',
        draftPreserved,
        draftRestored,
        assistantCountBefore,
      };
    } finally {
      autoProbeRunning = false;
    }
  }

  function assistantMessages() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }

  async function resolveModelNamesWithChatGpt(message) {
    const before = assistantMessages().length;
    const result = await autoSendProbe({
      probeText: String(message?.prompt || '').slice(0, 1800),
      probeMarker: 'GPTWork 模型名称解析',
    });
    const response = await waitUntil(() => {
      const messages = assistantMessages();
      if (messages.length <= before) return null;
      const text = String(messages[messages.length - 1]?.innerText || messages[messages.length - 1]?.textContent || '').trim();
      return text || null;
    }, 45000, 250);
    return { ...result, responseText: response || '' };
  }

  async function verifyAccountModel(message) {
    const model = normalizeDisplayedModel(message?.model) || String(message?.model || '').trim().toLowerCase() || null;
    const selectorKey = String(message?.selectorKey || '').trim();
    const label = String(message?.label || model || selectorKey || '').trim();
    if (!model && !selectorKey && !label) throw new Error('Invalid account model / 无效账户模型');
    await waitForIdle();
    const selection = await selectModelForVerification({ model, selectorKey, label });
    return {
      model,
      selectorKey,
      label,
      selectionAttempted: selection.attempted === true,
      observation: selection.observation || collectObservation(),
      capturedAt: new Date().toISOString(),
    };
  }

  async function discoverAccountModelMetadata() {
    const evidence = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
    const currentBeforeOpen = collectObservation();
    const models = [];
    const reasoning = new Set();
    let candidateCount = 0;
    let triggerFound = false;

    const rememberRow = (row) => {
      const descriptor = rowModelDescriptor(row);
      const canonical = descriptor.model || null;
      const unresolvedLatest = /^(latest|最新|최신)$/i.test(String(descriptor.label || '').trim());
      const modelSignalled = /model|gpt/i.test(String(descriptor.selectorKey || ''));
      if (!canonical && !unresolvedLatest && !modelSignalled) return;
      if (!canonical && !descriptor.selectorKey) return;
      if (!models.some((item) =>
        item.rawId === descriptor.rawId
        && item.model === canonical
        && item.selectorKey === descriptor.selectorKey
      )) {
        models.push({
          rawId: descriptor.rawId,
          model: canonical,
          selectorKey: descriptor.selectorKey,
          label: descriptor.label || canonical || descriptor.selectorKey,
        });
      }
    };

    const modern = await openModernModelMenu();
    triggerFound = Boolean(modern.trigger);
    if (modern.picker) {
      for (const row of [...modern.picker.querySelectorAll('[role="menuitemradio"],[role="radio"]')].filter(visible)) {
        for (const value of elementTexts(row)) {
          const level = normalizeDisplayedReasoning(value) || evidence?.reasoningFromText?.(value);
          if (level) reasoning.add(level);
        }
      }
    }
    if (modern.rows.length) {
      candidateCount = modern.rows.length;
      for (const row of modern.rows) rememberRow(row);
      await closeModelMenus(modern.trigger);
    } else if (!modern.picker) {
      // Legacy fallback is permitted only when the known composer model trigger itself
      // opened a menu. Never scan arbitrary global menus: sidebar and conversation
      // action menus are intentionally out of scope.
      await closeModelMenus(modern.trigger);
      const trigger = modelTrigger(MODEL_SELECTORS);
      triggerFound = triggerFound || Boolean(trigger);
      const wasExpanded = trigger?.getAttribute?.('aria-expanded') === 'true';
      let openedByUs = false;
      if (trigger && !wasExpanded) {
        const opened = await modelPickerPointer(trigger, 'click', 'legacy-model-trigger');
        openedByUs = Boolean(opened);
      }
      const rows = trigger
        ? (await waitUntil(() => {
          const controlsId = trigger.getAttribute?.('aria-controls') || '';
          const controlled = controlsId ? document.getElementById(controlsId) : null;
          const scope = controlled && visible(controlled) ? controlled : visibleIntelligencePickerContent();
          const candidates = verifiedModelRows(scope);
          return candidates.length ? candidates : null;
        }, 2200, 80)) || []
        : [];
      candidateCount = rows.length;
      for (const row of rows) {
        rememberRow(row);
        for (const value of elementTexts(row)) {
          const level = normalizeDisplayedReasoning(value) || evidence?.reasoningFromText?.(value);
          if (level) reasoning.add(level);
        }
      }
      if (openedByUs && trigger) await closeModelMenus(trigger);
    } else {
      candidateCount = 0;
      await closeModelMenus(modern.trigger);
    }

    const current = currentBeforeOpen?.model ? currentBeforeOpen : collectObservation();
    // Picker mode B exposes the concrete account catalog in the advanced model rows.
    // The composer trigger can combine model + reasoning text (for example
    // "GPT-5.6 Luna 高"); normalizing that trigger can manufacture a fake "gpt-5.6"
    // entry. Never promote that combined trigger into the mode-B model catalog.
    if (modern.pickerMode !== 'B' && current?.model && !models.some((item) => item.model === current.model)) {
      models.push({ rawId: current.model, model: current.model, label: current.modelLabel || current.model });
    }
    if (current?.reasoning) reasoning.add(current.reasoning);
    return {
      models,
      reasoningLevels: [...reasoning],
      capturedAt: new Date().toISOString(),
      candidateCount,
      triggerFound,
      pickerKind: modern.picker ? 'unified-intelligence' : 'legacy',
      pickerMode: modern.pickerMode || null,
    };
  }

  function diagnosticPerformanceSnapshot({ reset = false } = {}) {
    const lifecycle = globalThis.__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__?.diagnosticsSnapshot?.({
      resetCallbacks: reset,
      resetDiagnosticLongTasks: reset,
    }) || null;
    const callbackMaxMs = lifecycle?.callbacks
      ? Math.max(0, ...Object.values(lifecycle.callbacks).map((item) => Number(item?.maxMs || 0)))
      : 0;
    const snapshot = {
      capturedAt: new Date().toISOString(),
      documentVisibility: document.visibilityState,
      maxLongTaskMs: Math.round(performanceTelemetry.maxLongTaskMs * 10) / 10,
      longTaskCount: performanceTelemetry.longTaskCount,
      recentLongTasks: performanceTelemetry.recentLongTasks.slice(-8),
      mutationCount: performanceTelemetry.mutationCount,
      mutationCallbacks: performanceTelemetry.mutationCallbacks,
      maxMutationCallbackMs: Math.round(performanceTelemetry.maxMutationCallbackMs * 10) / 10,
      maxRuntimeCallbackMs: Math.round(callbackMaxMs * 10) / 10,
      runtimeLifecycle: lifecycle,
    };
    if (reset) {
      performanceTelemetry.mutationCount = 0;
      performanceTelemetry.mutationCallbacks = 0;
      performanceTelemetry.maxMutationCallbackMs = 0;
      performanceTelemetry.longTaskCount = 0;
      performanceTelemetry.maxLongTaskMs = 0;
      performanceTelemetry.recentLongTasks = [];
    }
    return snapshot;
  }

  function setDiagnosticContentSuspended(suspended, captureActive = null) {
    const next = suspended === true;
    const lifecycle = globalThis.__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__;
    const captureAuthority = typeof captureActive === 'boolean'
      ? lifecycle?.setDiagnosticCaptureActive?.(captureActive)
      : null;
    const authority = lifecycle?.setDiagnosticSuspended?.(next, 'background-jank-isolation') || null;
    // Compatibility mirror only. The lifecycle above is the sole callback/timer/observer
    // authority for diagnostic suspension; feature scripts must not own separate gates.
    globalThis.__GPTWORK_DIAGNOSTIC_CONTENT_SUSPENDED__ = next;
    const hostIds = ['gptlock-indicator-host', 'gptlock-verification-progress-host'];
    for (const id of hostIds) {
      const node = document.getElementById(id);
      if (node) node.style.display = next ? 'none' : '';
    }
    return { suspended: next, timestamp: new Date().toISOString(), authority, captureAuthority };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND') {
      sendResponse({ ok: true, ...setDiagnosticContentSuspended(message.suspended, message.captureActive) });
      return false;
    }
    if (message?.type === 'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT') {
      sendResponse({
        ok: true,
        details: diagnosticPerformanceSnapshot({ reset: message.reset === true }),
      });
      return false;
    }
    if (message?.type === 'GPTLOCK_AUTO_RESOLVE_MODEL_NAMES') {
      void resolveModelNamesWithChatGpt(message).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_VERIFY_ACCOUNT_MODEL') {
      void verifyAccountModel(message).then(
        (result) => sendResponse({ ok: true, result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_DISCOVER_ACCOUNT_MODELS') {
      void discoverAccountModelMetadata().then(
        (catalog) => sendResponse({ ok: true, catalog }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_COLLECT_PAGE_STATE') {
      sendResponse({ ok: true, observation: collectObservation() });
      return false;
    }
    if (message?.type === 'GPTLOCK_GUARD_STATE') {
      lastRuntimeContactAt = Date.now();
      updateCache(message);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'GPTLOCK_AUTO_SEND_PROBE') {
      void autoSendProbe(message).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_VERIFY_ENTER_WORK_MODE') {
      void enterVerificationWorkMode().then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_STOP_STALE_GENERATION') {
      void stopStaleGeneration().then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_WAIT_FOR_PROBE_SETTLED') {
      void waitForProbeTurnSettled(message).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    return false;
  });

  new MutationObserver((mutations) => {
    const startedAt = performance.now();
    // DOM observation never performs clicks. All ChatGPT UI mutation is owned by an
    // explicit model-selection transaction. Typing/streaming text is the hottest DOM path in ChatGPT. It cannot change lock
    // identity by itself, so never schedule a whole-page observation for pure text edits.
    const relevant = mutations.some((mutation) => {
      if (mutation.type === 'characterData') return false;
      const target = mutation.target?.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target?.parentElement;
      if (!target) return false;
      if (target.closest?.('textarea,[contenteditable="true"]')) return false;
      // Assistant/user transcript streaming is extremely mutation-heavy but cannot
      // change the composer-owned model/reasoning identity. v0.5.111 still scheduled
      // a whole-page observation after these mutations; keep that hot path dormant.
      if (target.closest?.('[data-message-author-role]')) return false;
      if (mutation.type === 'attributes') return true;
      const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      if (!nodes.length) return false;
      return nodes.some((node) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (!element) return false;
        if (element.closest?.('[data-message-author-role]')) return false;
        if (element.matches?.('button,[role="button"],[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="radio"],[aria-haspopup],[data-testid*="model"],[data-testid*="reasoning"],[data-testid*="thinking"]')) return true;
        return Boolean(element.querySelector?.('button,[role="button"],[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="radio"],[aria-haspopup],[data-testid*="model"],[data-testid*="reasoning"],[data-testid*="thinking"]'));
      });
    });
    if (relevant) scheduleReport();
    recordMutationCost(mutations.length, startedAt);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'aria-label',
      'aria-checked',
      'aria-selected',
      'data-state',
      'data-selected',
      'data-value',
      'data-model',
      'data-model-id',
      'title',
      'data-testid',
    ],
  });

  window.setInterval(() => {
    if (cachedSettings?.enabled === false || cachedState?.guard?.canSend !== false) return;
    if (!runtimeContextAvailable()) {
      failOpenStaleRuntime();
      return;
    }
    void sendMessage({ type: 'GPTLOCK_GET_STATE' })
      .then((state) => updateCache({ state: state.tabState, policy: state.policy, settings: state.settings }))
      .catch(() => failOpenStaleRuntime());
  }, BLOCKING_GUARD_HEARTBEAT_MS);

  window.addEventListener('resize', () => {
    positionVerificationProgressHost(document.getElementById('gptlock-verification-progress-host'));
  });

  ensureIndicator();
  void sendMessage({ type: 'GPTLOCK_GET_STATE' })
    .then((state) => updateCache({ state: state.tabState, policy: state.policy, settings: state.settings }))
    .catch(() => failOpenStaleRuntime());
  scheduleReport();
})();

