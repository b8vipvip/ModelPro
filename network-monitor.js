import {
  decodeCdpBody,
  extractRequestEvidence,
  extractResponseEvidence,
  extractStreamHandoff,
  isChatGptConversationRequest,
  publicStreamHandoff,
  rewriteConversationPostData,
  streamPayloadMatches,
} from './network-evidence.js';

const CDP_VERSION = '1.3';
const REQUEST_TTL_MS = 15 * 60 * 1000;
const STREAM_TTL_MS = 2 * 60 * 1000;
const PROVISIONAL_STREAM_WINDOW_MS = 12 * 1000;
const FETCH_PATTERNS = [
  { urlPattern: 'https://chatgpt.com/backend-api/conversation*', requestStage: 'Request' },
  { urlPattern: 'https://chatgpt.com/backend-api/f/conversation*', requestStage: 'Request' },
];

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticEndpoint(value) {
  try {
    return new URL(value).pathname
      .split('/')
      .map((segment) => (/^[a-z0-9_-]{20,}$/i.test(segment) ? ':id' : segment))
      .join('/');
  } catch {
    return 'invalid-url';
  }
}

function isChatGptHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function isConversationMetadataEndpoint(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return path === '/backend-api/conversations'
      || /^\/backend-api\/conversation\/[^/]+$/i.test(path);
  } catch {
    return false;
  }
}

function looksLikeStreamEndpoint(value) {
  try {
    const url = new URL(value);
    if (isConversationMetadataEndpoint(value)) return false;
    return /(?:conversation|stream|events|sse|topic|turn)/i.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function hasCompleteResponseEvidence(evidence) {
  return Boolean(
    evidence?.model
      && evidence?.reasoning
      && !evidence?.conflicts?.model
      && !evidence?.conflicts?.reasoning,
  );
}

export function hasResponseMetadataEvidence(evidence) {
  return Boolean(
    evidence?.model
      || evidence?.reasoning
      || evidence?.conflicts?.model
      || evidence?.conflicts?.reasoning,
  );
}

export function webSocketFrameMatchesHandoff(payload, handoff) {
  return Boolean(handoff && streamPayloadMatches(payload, handoff));
}

export class ChatGptNetworkMonitor {
  constructor({ onStatus, onRequest, onEvidence, onFailure, onRewrite, onStreamData, getLockConfiguration, getVerificationTransaction }) {
    this.onStatus = onStatus;
    this.onRequest = onRequest;
    this.onEvidence = onEvidence;
    this.onFailure = onFailure;
    this.onRewrite = onRewrite;
    this.onStreamData = onStreamData;
    this.getLockConfiguration = getLockConfiguration;
    this.getVerificationTransaction = getVerificationTransaction;
    this.attachedTabs = new Set();
    this.responseCaptureTabs = new Set();
    this.attachTasks = new Map();
    this.detachTasks = new Map();
    this.requests = new Map();
    this.handoffs = new Map();
    this.webSockets = new Map();
    this.lastFormalRequestByTab = new Map();
    this.webSocketSequence = 0;
    this.lastPurgeAt = 0;
    this.diagnosticSuspended = false;
    this.diagnosticCounters = {
      startedAt: Date.now(),
      cdpEvents: 0,
      fetchPaused: 0,
      networkEvents: 0,
      webSocketFrames: 0,
    };
    chrome.debugger.onEvent.addListener((source, method, params) => {
      void this.handleEvent(source, method, params);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (!source.tabId) return;
      this.attachedTabs.delete(source.tabId);
      this.dropTabRequests(source.tabId);
      this.onStatus(source.tabId, { attached: false, error: `detached:${reason}` });
    });
  }

  target(tabId) {
    return { tabId };
  }

  async setDiagnosticSuspended(suspended) {
    const next = suspended === true;
    if (this.diagnosticSuspended === next) return { suspended: next, detachedTabs: 0 };
    this.diagnosticSuspended = next;
    let detachedTabs = 0;
    if (next) {
      for (const tabId of [...this.attachedTabs]) {
        try {
          await this.detach(tabId);
          detachedTabs += 1;
        } catch {}
      }
    }
    return { suspended: next, detachedTabs };
  }

  isDiagnosticSuspended() {
    return this.diagnosticSuspended === true;
  }

  configuration(tabId) {
    try {
      return this.getLockConfiguration?.(tabId) ?? {};
    } catch {
      return {};
    }
  }

  verificationTransaction(tabId) {
    try {
      return this.getVerificationTransaction?.(tabId) ?? null;
    } catch {
      return null;
    }
  }

  effectiveConfiguration(tabId) {
    const base = this.configuration(tabId);
    const transaction = this.verificationTransaction(tabId);
    const model = String(transaction?.model || '').trim();
    if (!model) {
      return {
        ...base,
        authorityKind: 'normal-policy',
        authorityModel: null,
        authorityStartedAt: null,
      };
    }
    // Fetch.requestPaused is the terminal request-mutation boundary. The selected
    // catalog model owns the forwarded request; there is no parallel "observe native
    // transport" authority and no alias path that can disagree with this decision.
    return {
      ...base,
      lockedModels: [model],
      preferredReasoning: null,
      preserveModel: false,
      preserveReasoning: true,
      bypassRewrite: false,
      forceModel: model,
      responseVerificationEnabled: true,
      knownModels: [...new Set([
        ...(Array.isArray(base.knownModels) ? base.knownModels : []),
        model,
      ])],
      authorityKind: 'verification-transaction',
      authorityModel: model,
      authorityStartedAt: Number(transaction?.startedAt) || null,
    };
  }

  async performAttach(tabId) {
    if (this.attachedTabs.has(tabId)) return true;
    const target = this.target(tabId);
    try {
      await debuggerCall('attach', target, CDP_VERSION);
    } catch (attachError) {
      try {
        await debuggerCall('sendCommand', target, 'Network.enable', {});
      } catch {
        const detail = safeError(attachError);
        this.onStatus(tabId, { attached: false, error: detail });
        return false;
      }
    }

    try {
      // Normal request locking only needs Fetch interception. Keeping Network enabled
      // on every ChatGPT tab mirrors every response/WebSocket frame through CDP and
      // measurably increases browser-wide main-thread pressure. Full Network capture
      // is enabled only for an explicit verification transaction.
      await debuggerCall('sendCommand', target, 'Fetch.enable', { patterns: FETCH_PATTERNS });
      this.attachedTabs.add(tabId);
      this.onStatus(tabId, { attached: true, error: null });
      return true;
    } catch (error) {
      try { await debuggerCall('sendCommand', target, 'Fetch.disable', {}); } catch {}
      try { await debuggerCall('detach', target); } catch {}
      const detail = safeError(error);
      this.onStatus(tabId, { attached: false, error: detail });
      return false;
    }
  }

  async attach(tabId) {
    if (this.diagnosticSuspended) {
      this.onStatus(tabId, { attached: false, error: 'diagnostic_cdp_suspended' });
      return false;
    }
    // A detach requested while an earlier attach is still running wins first. Any new
    // attach waits for that detach, then starts a fresh lifecycle instead of returning
    // the stale in-flight attach Promise.
    const pendingDetach = this.detachTasks.get(tabId);
    if (pendingDetach) {
      try { await pendingDetach; } catch {}
    }
    if (this.attachedTabs.has(tabId)) return true;
    const existing = this.attachTasks.get(tabId);
    if (existing) return existing;

    const task = this.performAttach(tabId).finally(() => {
      if (this.attachTasks.get(tabId) === task) this.attachTasks.delete(tabId);
    });
    this.attachTasks.set(tabId, task);
    return task;
  }

  async enableResponseCapture(tabId) {
    const attached = this.isAttached(tabId) || await this.attach(tabId);
    if (!attached) return false;
    if (this.responseCaptureTabs.has(tabId)) return true;
    await debuggerCall('sendCommand', this.target(tabId), 'Network.enable', {
      maxTotalBufferSize: 32 * 1024 * 1024,
      maxResourceBufferSize: 16 * 1024 * 1024,
      maxPostDataSize: 2 * 1024 * 1024,
    });
    this.responseCaptureTabs.add(tabId);
    return true;
  }

  async disableResponseCapture(tabId) {
    this.responseCaptureTabs.delete(tabId);
    try { await debuggerCall('sendCommand', this.target(tabId), 'Network.disable', {}); } catch {}
    this.dropTabRequests(tabId);
  }

  attachedCount() {
    return this.attachedTabs.size;
  }

  responseCaptureCount() {
    return this.responseCaptureTabs.size;
  }

  diagnosticsSnapshot({ reset = false } = {}) {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - Number(this.diagnosticCounters.startedAt || now));
    const snapshot = {
      elapsedMs,
      attachedTabs: this.attachedTabs.size,
      responseCaptureTabs: this.responseCaptureTabs.size,
      cdpEvents: this.diagnosticCounters.cdpEvents,
      fetchPaused: this.diagnosticCounters.fetchPaused,
      networkEvents: this.diagnosticCounters.networkEvents,
      webSocketFrames: this.diagnosticCounters.webSocketFrames,
      cdpEventsPerSecond: Math.round((this.diagnosticCounters.cdpEvents * 10000) / elapsedMs) / 10,
    };
    if (reset) {
      this.diagnosticCounters = {
        startedAt: now,
        cdpEvents: 0,
        fetchPaused: 0,
        networkEvents: 0,
        webSocketFrames: 0,
      };
    }
    return snapshot;
  }

  async performDetach(tabId) {
    this.attachedTabs.delete(tabId);
    this.responseCaptureTabs.delete(tabId);
    this.dropTabRequests(tabId);
    try { await debuggerCall('sendCommand', this.target(tabId), 'Fetch.disable', {}); } catch {}
    try { await debuggerCall('detach', this.target(tabId)); } catch {}
    this.onStatus(tabId, { attached: false, error: null });
  }

  async detach(tabId) {
    const existing = this.detachTasks.get(tabId);
    if (existing) return existing;

    const task = (async () => {
      const pendingAttach = this.attachTasks.get(tabId);
      if (pendingAttach) {
        try { await pendingAttach; } catch {}
      }
      await this.performDetach(tabId);
    })().finally(() => {
      if (this.detachTasks.get(tabId) === task) this.detachTasks.delete(tabId);
    });
    this.detachTasks.set(tabId, task);
    return task;
  }

  isAttached(tabId) {
    return this.attachedTabs.has(tabId);
  }

  async trustedPointer(tabId, { action = 'click', x, y } = {}) {
    const clientX = Number(x);
    const clientY = Number(y);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      throw new Error('Trusted pointer coordinates are invalid');
    }
    const attached = this.isAttached(tabId) || await this.attach(tabId);
    if (!attached) throw new Error('Debugger is not attached for trusted pointer input');
    const target = this.target(tabId);
    if (action === 'move') {
      await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: clientX,
        y: clientY,
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      });
      return true;
    }
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clientX,
      y: clientY,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clientX,
      y: clientY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clientX,
      y: clientY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
    return true;
  }

  key(tabId, requestId) {
    return `${tabId}:${requestId}`;
  }

  dropTabRequests(tabId) {
    const prefix = `${tabId}:`;
    for (const key of this.requests.keys()) if (key.startsWith(prefix)) this.requests.delete(key);
    for (const key of this.handoffs.keys()) if (key.startsWith(prefix)) this.handoffs.delete(key);
    for (const key of this.webSockets.keys()) if (key.startsWith(prefix)) this.webSockets.delete(key);
    this.lastFormalRequestByTab.delete(tabId);
  }

  purgeOldRequests() {
    const requestCutoff = Date.now() - REQUEST_TTL_MS;
    for (const [key, request] of this.requests) {
      if (request.startedAt < requestCutoff) this.requests.delete(key);
    }
    const streamCutoff = Date.now() - STREAM_TTL_MS;
    for (const [key, handoff] of this.handoffs) {
      if (handoff.startedAt < streamCutoff) this.handoffs.delete(key);
    }
    for (const [key, socket] of this.webSockets) {
      if ((socket.lastActivityAt || socket.startedAt || 0) < streamCutoff) this.webSockets.delete(key);
    }
  }

  activeHandoffs(tabId) {
    const now = Date.now();
    return [...this.handoffs.values()]
      .filter((handoff) => handoff.tabId === tabId && now - handoff.startedAt <= STREAM_TTL_MS)
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  newestHandoff(tabId) {
    return this.activeHandoffs(tabId)[0] ?? null;
  }

  matchHandoff(tabId, payload) {
    return this.activeHandoffs(tabId).find((handoff) => streamPayloadMatches(payload, handoff)) ?? null;
  }

  registerHandoff(tabId, initialRequestId, parsed) {
    if (!parsed) return null;
    const key = this.key(tabId, initialRequestId);
    const handoff = {
      ...parsed,
      id: key,
      tabId,
      initialRequestId,
      startedAt: Date.now(),
    };
    this.handoffs.set(key, handoff);
    this.onStreamData?.(tabId, {
      requestId: initialRequestId,
      capturedAt: new Date().toISOString(),
      rawStreamData: null,
      diagnostics: {
        transport: 'handoff',
        direction: 'received',
        stage: 'handoff_detected',
        streamHandoff: publicStreamHandoff(handoff),
      },
      streamContext: this.streamContext(handoff, { isDownstream: false, transport: 'handoff', stage: 'handoff_detected' }),
    });
    return handoff;
  }

  resolveFinishedHandoff(tabId, record, body = '') {
    let handoff = record?.handoffId ? this.handoffs.get(record.handoffId) ?? null : null;
    if (!record?.downstream) {
      const parsedHandoff = extractStreamHandoff(body);
      if (parsedHandoff) handoff = this.registerHandoff(tabId, record.requestId, parsedHandoff);
    } else if (!handoff) {
      handoff = this.matchHandoff(tabId, `${record.url}\n${body}`) || this.newestHandoff(tabId);
    }
    return handoff;
  }

  downstreamResponseMatchesHandoff(record, body, handoff) {
    if (!record?.downstream) return true;
    if (!handoff) return false;
    if (!record.downstreamCandidate) return true;
    if (streamPayloadMatches(`${record.url}\n${body}`, handoff)) return true;
    const age = Date.now() - handoff.startedAt;
    return age <= PROVISIONAL_STREAM_WINDOW_MS && /event-stream/i.test(record.mimeType || '');
  }

  streamContext(handoff, extra = {}) {
    return {
      isDownstream: extra.isDownstream !== false,
      initialRequestId: handoff?.initialRequestId ?? null,
      conversationId: handoff?.conversationId ?? null,
      turnExchangeId: handoff?.turnExchangeId ?? null,
      topicIds: Array.isArray(handoff?.topicIds) ? handoff.topicIds : [],
      transport: extra.transport ?? null,
      direction: extra.direction ?? 'received',
      stage: extra.stage ?? 'downstream',
      matchBasis: extra.matchBasis ?? null,
    };
  }

  async handleEvent(source, method, params = {}) {
    const tabId = source.tabId;
    if (!tabId || !this.attachedTabs.has(tabId)) return;
    this.diagnosticCounters.cdpEvents += 1;
    if (method === 'Fetch.requestPaused') this.diagnosticCounters.fetchPaused += 1;
    if (method.startsWith('Network.')) this.diagnosticCounters.networkEvents += 1;
    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      this.diagnosticCounters.webSocketFrames += 1;
    }
    if (method.startsWith('Network.') && !this.responseCaptureTabs.has(tabId)) return;
    const now = Date.now();
    if (now - this.lastPurgeAt >= 5000) {
      this.lastPurgeAt = now;
      this.purgeOldRequests();
    }

    if (method === 'Fetch.requestPaused') {
      await this.handlePausedRequest(tabId, params);
    } else if (method === 'Network.requestWillBeSent') {
      await this.handleRequest(tabId, params);
    } else if (method === 'Network.responseReceived') {
      this.handleResponse(tabId, params);
    } else if (method === 'Network.loadingFinished') {
      await this.handleFinished(tabId, params);
    } else if (method === 'Network.loadingFailed') {
      this.handleFailed(tabId, params);
    } else if (method === 'Network.webSocketCreated') {
      this.handleWebSocketCreated(tabId, params);
    } else if (method === 'Network.webSocketFrameSent') {
      this.handleWebSocketFrame(tabId, params, 'sent');
    } else if (method === 'Network.webSocketFrameReceived') {
      this.handleWebSocketFrame(tabId, params, 'received');
    } else if (method === 'Network.webSocketClosed') {
      this.webSockets.delete(this.key(tabId, String(params.requestId)));
    }
  }

  async continuePaused(tabId, requestId, postData = null) {
    const parameters = { requestId };
    if (typeof postData === 'string') parameters.postData = encodeUtf8Base64(postData);
    await debuggerCall('sendCommand', this.target(tabId), 'Fetch.continueRequest', parameters);
  }

  async failPaused(tabId, requestId, errorReason = 'BlockedByClient') {
    await debuggerCall('sendCommand', this.target(tabId), 'Fetch.failRequest', {
      requestId,
      errorReason,
    });
  }

  async pausedPostData(tabId, params) {
    if (typeof params.request?.postData === 'string') return params.request.postData;
    if (!params.networkId) return '';
    try {
      const result = await debuggerCall(
        'sendCommand',
        this.target(tabId),
        'Network.getRequestPostData',
        { requestId: String(params.networkId) },
      );
      return result?.postData ?? '';
    } catch {
      return '';
    }
  }

  async handlePausedRequest(tabId, params) {
    const requestId = String(params.requestId);
    const request = params.request ?? {};
    const endpoint = diagnosticEndpoint(request.url);
    if (!isChatGptConversationRequest(request.url, request.method)) {
      try {
        await this.continuePaused(tabId, requestId);
      } catch (error) {
        this.onRewrite?.(tabId, { endpoint, changed: false, reason: 'continue_failed', error: safeError(error) });
      }
      return;
    }

    let configuration = null;
    let rewrite = null;
    try {
      const postData = await this.pausedPostData(tabId, params);
      // Resolve authority only after postData acquisition. This closes the race where
      // a normal-policy snapshot was taken before verification became active.
      configuration = this.effectiveConfiguration(tabId);
      if (configuration.bypassRewrite === true) {
        const observed = extractRequestEvidence(postData);
        await this.continuePaused(tabId, requestId);
        this.onRewrite?.(tabId, {
          endpoint,
          requestId: params.networkId ? String(params.networkId) : null,
          fetchRequestId: requestId,
          changed: false,
          reason: 'verification_passthrough_late_authority',
          modelBefore: observed.model,
          modelAfter: observed.model,
          reasoningBefore: observed.reasoning,
          reasoningAfter: observed.reasoning,
          reasoningFields: [],
          authorityKind: configuration.authorityKind,
          authorityModel: configuration.authorityModel,
          authorityStartedAt: configuration.authorityStartedAt,
        });
        return;
      }
      rewrite = rewriteConversationPostData(postData, configuration);
      if (
        configuration.authorityKind === 'verification-transaction'
        && rewrite.modelAfter !== configuration.authorityModel
      ) {
        const detail = `verification_request_authority_mismatch:${rewrite.modelAfter || 'none'}!=${configuration.authorityModel}`;
        this.onRewrite?.(tabId, {
          endpoint,
          requestId: params.networkId ? String(params.networkId) : null,
          fetchRequestId: requestId,
          changed: rewrite.changed,
          reason: 'verification_authority_mismatch_blocked',
          modelBefore: rewrite.modelBefore,
          modelAfter: rewrite.modelAfter,
          transportModelBefore: rewrite.transportModelBefore,
          transportModelAfter: rewrite.transportModelAfter,
          reasoningBefore: rewrite.reasoningBefore,
          reasoningAfter: rewrite.reasoningAfter,
          reasoningFields: rewrite.reasoningFields,
          authorityKind: configuration.authorityKind,
          authorityModel: configuration.authorityModel,
          authorityStartedAt: configuration.authorityStartedAt,
          error: detail,
        });
        await this.failPaused(tabId, requestId);
        return;
      }
      await this.continuePaused(tabId, requestId, rewrite.changed ? rewrite.postData : null);
      this.onRewrite?.(tabId, {
        endpoint,
        requestId: params.networkId ? String(params.networkId) : null,
          fetchRequestId: requestId,
        changed: rewrite.changed,
        reason: rewrite.reason,
        modelBefore: rewrite.modelBefore,
        modelAfter: rewrite.modelAfter,
        transportModelBefore: rewrite.transportModelBefore,
        transportModelAfter: rewrite.transportModelAfter,
        reasoningBefore: rewrite.reasoningBefore,
        reasoningAfter: rewrite.reasoningAfter,
        reasoningFields: rewrite.reasoningFields,
        authorityKind: configuration.authorityKind,
        authorityModel: configuration.authorityModel,
        authorityStartedAt: configuration.authorityStartedAt,
      });
    } catch (error) {
      const detail = safeError(error);
      if (configuration?.authorityKind === 'verification-transaction') {
        this.onRewrite?.(tabId, {
          endpoint,
          requestId: params.networkId ? String(params.networkId) : null,
          fetchRequestId: requestId,
          changed: false,
          reason: 'verification_rewrite_failed_closed',
          modelBefore: rewrite?.modelBefore ?? null,
          modelAfter: rewrite?.modelAfter ?? null,
          authorityKind: configuration.authorityKind,
          authorityModel: configuration.authorityModel,
          authorityStartedAt: configuration.authorityStartedAt,
          error: detail,
        });
        try { await this.failPaused(tabId, requestId); } catch {}
        return;
      }
      this.onRewrite?.(tabId, {
        endpoint,
        requestId: params.networkId ? String(params.networkId) : null,
          fetchRequestId: requestId,
        changed: false,
        reason: 'rewrite_failed_open',
        modelBefore: rewrite?.modelBefore ?? null,
        modelAfter: rewrite?.modelAfter ?? null,
        error: detail,
      });
      try {
        await this.continuePaused(tabId, requestId);
      } catch (continueError) {
        this.onRewrite?.(tabId, {
          endpoint,
          changed: false,
          reason: 'continue_after_rewrite_failure_failed',
          error: safeError(continueError),
        });
      }
    }
  }

  async requestPostData(tabId, requestId, request) {
    if (typeof request?.postData === 'string') return request.postData;
    try {
      const result = await debuggerCall(
        'sendCommand',
        this.target(tabId),
        'Network.getRequestPostData',
        { requestId },
      );
      return result?.postData ?? '';
    } catch {
      return '';
    }
  }

  async handleRequest(tabId, params) {
    const request = params.request ?? {};
    const requestId = String(params.requestId);
    if (isChatGptConversationRequest(request.url, request.method)) {
      const configuration = this.configuration(tabId);
      const record = {
        tabId,
        requestId,
        startedAt: Date.now(),
        url: request.url,
        endpoint: diagnosticEndpoint(request.url),
        mimeType: '',
        responseHeaders: {},
        responseVerificationEnabled: configuration.responseVerificationEnabled !== false,
        downstream: false,
      };
      this.requests.set(this.key(tabId, requestId), record);
      this.lastFormalRequestByTab.set(tabId, { requestId, startedAt: record.startedAt });

      const postData = await this.requestPostData(tabId, requestId, request);
      const requested = extractRequestEvidence(postData);
      this.onRequest(tabId, {
        requestId,
        capturedAt: new Date().toISOString(),
        model: requested.model,
        reasoning: requested.reasoning,
        conflicts: requested.conflicts,
        fields: requested.fields,
        diagnostics: { endpoint: record.endpoint, ...requested.diagnostics },
      });
      return;
    }

    // History/list/detail reads can contain the active conversation id and therefore
    // match a live handoff by content, but they are not transport evidence for the
    // current generation and must never participate in served-model verification.
    if (!isChatGptHttps(request.url) || isConversationMetadataEndpoint(request.url)) return;
    if (!this.activeHandoffs(tabId).length) {
      const recent = this.lastFormalRequestByTab.get(tabId);
      if (!recent || Date.now() - recent.startedAt > PROVISIONAL_STREAM_WINDOW_MS) return;
      if (!looksLikeStreamEndpoint(request.url)) return;
    }

    const postData = await this.requestPostData(tabId, requestId, request);
    const handoff = this.matchHandoff(tabId, `${request.url}\n${postData}`);
    const recent = this.lastFormalRequestByTab.get(tabId);
    const provisional = !handoff && recent && Date.now() - recent.startedAt <= PROVISIONAL_STREAM_WINDOW_MS
      && looksLikeStreamEndpoint(request.url);
    if (!handoff && !provisional) return;
    this.requests.set(this.key(tabId, requestId), {
      tabId,
      requestId,
      startedAt: Date.now(),
      url: request.url,
      endpoint: diagnosticEndpoint(request.url),
      mimeType: '',
      responseHeaders: {},
      responseVerificationEnabled: true,
      downstream: true,
      downstreamCandidate: provisional,
      handoffId: handoff?.id ?? null,
      matchBasis: handoff ? 'request_marker' : 'provisional_after_formal_request',
    });
  }

  handleResponse(tabId, params) {
    const key = this.key(tabId, String(params.requestId));
    let record = this.requests.get(key);
    const mimeType = params.response?.mimeType ?? '';
    if (!record && /event-stream/i.test(mimeType) && isChatGptHttps(params.response?.url || '')) {
      const handoff = this.newestHandoff(tabId);
      if (handoff && looksLikeStreamEndpoint(params.response?.url || '')) {
        record = {
          tabId,
          requestId: String(params.requestId),
          startedAt: Date.now(),
          url: params.response?.url || '',
          endpoint: diagnosticEndpoint(params.response?.url || ''),
          mimeType: '',
          responseHeaders: {},
          responseVerificationEnabled: true,
          downstream: true,
          downstreamCandidate: true,
          handoffId: handoff.id,
          matchBasis: 'event_stream_response_after_handoff',
        };
        this.requests.set(key, record);
      }
    }
    if (!record) return;
    record.mimeType = mimeType;
    record.responseHeaders = params.response?.headers ?? {};
    record.status = params.response?.status ?? null;
  }

  async handleFinished(tabId, params) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record) return;
    this.requests.delete(key);
    if (!record.responseVerificationEnabled) return;

    let body = '';
    let bodyError = null;
    try {
      const result = await debuggerCall(
        'sendCommand',
        this.target(tabId),
        'Network.getResponseBody',
        { requestId: record.requestId },
      );
      body = decodeCdpBody(result?.body ?? '', Boolean(result?.base64Encoded));
    } catch (error) {
      bodyError = safeError(error);
    }

    const handoff = this.resolveFinishedHandoff(tabId, record, body);
    if (!this.downstreamResponseMatchesHandoff(record, body, handoff)) return;

    const evidence = extractResponseEvidence({
      body,
      headers: record.responseHeaders,
      mimeType: record.mimeType,
    });
    const streamHandoff = !record.downstream && handoff ? publicStreamHandoff(handoff) : null;
    const streamContext = handoff
      ? this.streamContext(handoff, {
        isDownstream: Boolean(record.downstream),
        transport: 'sse',
        direction: 'received',
        stage: record.downstream ? 'downstream_http' : 'initial_conversation',
        matchBasis: record.matchBasis ?? (record.downstream ? 'handoff_marker' : 'formal_request'),
      })
      : null;
    const diagnostics = {
      endpoint: record.endpoint,
      httpStatus: record.status,
      encodedDataLength: Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null,
      transport: 'sse',
      direction: 'received',
      stage: record.downstream ? 'downstream_http' : 'initial_conversation',
      streamHandoff,
      ...evidence.diagnostics,
    };

    if (!bodyError && !hasResponseMetadataEvidence(evidence)) {
      this.onStreamData?.(tabId, {
        requestId: record.requestId,
        capturedAt: new Date().toISOString(),
        rawStreamData: body,
        diagnostics: { ...diagnostics, verificationSuppressedReason: evidence.conflicts?.model || evidence.conflicts?.reasoning
          ? 'conflicting_metadata'
          : 'incomplete_metadata' },
        streamContext,
      });
      body = '';
      return;
    }

    this.onEvidence(tabId, {
      requestId: record.requestId,
      capturedAt: new Date().toISOString(),
      status: record.status,
      model: evidence.model,
      reasoning: evidence.reasoning,
      conflicts: evidence.conflicts,
      fields: evidence.fields,
      bodyError,
      rawResponseBody: (/event-stream/i.test(record.mimeType) || String(evidence.diagnostics?.bodyFormat || '').includes('sse'))
        ? body
        : null,
      streamContext,
      diagnostics,
    });
    body = '';
  }

  handleFailed(tabId, params) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record) return;
    this.requests.delete(key);
    if (!record.responseVerificationEnabled) return;
    this.onFailure(tabId, {
      requestId: record.requestId,
      error: params.errorText || 'network_loading_failed',
      canceled: Boolean(params.canceled),
      endpoint: record.endpoint,
      httpStatus: record.status,
      downstream: Boolean(record.downstream),
    });
  }

  handleWebSocketCreated(tabId, params) {
    const requestId = String(params.requestId);
    const handoff = this.matchHandoff(tabId, params.url || '');
    this.webSockets.set(this.key(tabId, requestId), {
      tabId,
      requestId,
      url: params.url || '',
      endpoint: diagnosticEndpoint(params.url || ''),
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      handoffId: handoff?.id ?? null,
      matchedAt: handoff ? Date.now() : null,
      matchBasis: handoff ? 'websocket_url_marker' : null,
    });
  }

  handleWebSocketFrame(tabId, params, direction) {
    const requestId = String(params.requestId);
    const key = this.key(tabId, requestId);
    let socket = this.webSockets.get(key);
    if (!socket) {
      socket = {
        tabId,
        requestId,
        url: '',
        endpoint: 'websocket',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        handoffId: null,
        matchedAt: null,
        matchBasis: null,
      };
      this.webSockets.set(key, socket);
    }
    socket.lastActivityAt = Date.now();
    const payload = typeof params.response?.payloadData === 'string' ? params.response.payloadData : '';
    const exact = this.matchHandoff(tabId, payload);
    if (!exact) return;

    const handoff = exact;
    socket.handoffId = exact.id;
    socket.matchedAt = Date.now();
    socket.matchBasis = direction === 'sent' ? 'subscription_frame_marker' : 'received_frame_marker';
    const streamContext = this.streamContext(handoff, {
      transport: 'websocket',
      direction,
      stage: 'downstream_websocket',
      matchBasis: socket.matchBasis,
    });
    if (direction === 'sent') return;
    const frameId = `ws-${requestId}-${++this.webSocketSequence}`;
    const evidence = extractResponseEvidence({ body: payload, headers: {}, mimeType: 'application/json' });
    const diagnostics = {
      endpoint: socket.endpoint,
      httpStatus: 101,
      transport: 'websocket',
      direction,
      stage: 'downstream_websocket',
      ...evidence.diagnostics,
      bodyFormat: evidence.diagnostics?.bodyFormat === 'unparsed'
        ? 'websocket_frame'
        : evidence.diagnostics?.bodyFormat,
    };

    if (!hasResponseMetadataEvidence(evidence)) {
      this.onStreamData?.(tabId, {
        requestId: frameId,
        capturedAt: new Date().toISOString(),
        rawStreamData: payload,
        diagnostics: { ...diagnostics, verificationSuppressedReason: evidence.conflicts?.model || evidence.conflicts?.reasoning
          ? 'conflicting_metadata'
          : 'incomplete_metadata' },
        streamContext,
      });
      return;
    }

    this.onEvidence(tabId, {
      requestId: frameId,
      capturedAt: new Date().toISOString(),
      status: 101,
      model: evidence.model,
      reasoning: evidence.reasoning,
      conflicts: evidence.conflicts,
      fields: evidence.fields,
      bodyError: null,
      rawResponseBody: payload,
      streamContext,
      diagnostics,
    });
  }
}
