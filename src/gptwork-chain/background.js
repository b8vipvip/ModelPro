import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  normalizeConcreteModelId,
  normalizePolicy,
  normalizeReasoningLevel,
  normalizeSettings,
} from './policy.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import { evaluateGuard } from './guard.js';
import { classifyNativeError } from './native-status.js';
import {
  appendDiagnosticSseCapture,
  appendRuntimeLog,
  clearRuntimeLogs,
  createDiagnosticSseCapture,
  finalizeDiagnosticSseCapture,
  getRuntimeLogs,
  markRuntimeLogsNative,
  runtimeLogNativeBatch,
  uploadRuntimeLogBatch,
  RUNTIME_LOG_UPLOAD_ALARM,
  RUNTIME_LOG_SYNC_KEY,
  sanitizeLogValue,
} from './runtime-log.js';
import { createAccountClient } from './account-client.js';
import {
  effectivePolicyForTabSync,
  enableWorkModeForVerification,
  tabFeatureEnabledSync,
} from './tab-feature-runtime.js';
import { ACCOUNT_REFRESH_ALARM } from './account-refresh-scheduler.js';

const RUNTIME_CODE_VERSION = '0.5.139';
const NATIVE_HOST = 'com.gptlock.core';
const RECONNECT_ALARM = 'gptlock-native-reconnect';
const REQUEST_TIMEOUT_MS = 7000;
const AUTO_VERIFY_RESPONSE_TIMEOUT_MS = 120000;
const AUTO_VERIFY_POLL_MS = 200;
const AUTO_VERIFY_HANDOFF_MIN_WAIT_MS = 9000;
const AUTO_VERIFY_HANDOFF_IDLE_MS = 1200;
const DIAGNOSTIC_SSE_STORAGE_KEY = 'autoVerificationSseCapture';
const MODEL_VERIFICATION_HISTORY_KEY = 'modelVerificationHistoryV1';
const MODEL_VERIFICATION_HISTORY_ENABLED_KEY = 'gptworkModelVerificationHistoryEnabled';
const MODEL_VERIFICATION_HISTORY_LIMIT = 50;
const LOCAL_ENABLED_KEY = 'gptworkEnabledLocal';
const SHARED_KNOWN_MODELS_KEY = 'gptworkSharedKnownModelsV1';
const JANK_ISOLATION_KEY = 'gptworkJankIsolationV1';

let nativePort = null;
let requestSequence = 0;
let currentPolicy = DEFAULT_POLICY;
let currentSettings = DEFAULT_SETTINGS;
let localEnabledOverride = null;
let coreConnection = { connected: false, error: null };
let initializeTask = null;
const pendingRequests = new Map();
const tabStates = new Map();
// Ephemeral per-tab verification transaction. This is the sole authority that can
// temporarily change request-lock behavior while a catalog model is being probed.
// It is intentionally independent of URL/context state migration.
const verificationTransactions = new Map();
const accountClient = createAccountClient();
let accountState = { authenticated: false, authorized: false, allowedWindowKeys: [], deniedWindowKeys: [] };
let sharedModelCatalogUnavailableUntil = 0;
let sharedKnownModelIds = new Set();
let diagnosticRuntimeSuspended = false;

function masterRuntimeEnabled() {
  return localEnabledOverride === true && currentSettings.enabled === true && !diagnosticRuntimeSuspended;
}

async function masterStorageEnabled() {
  try {
    const stored = await chrome.storage.local.get(LOCAL_ENABLED_KEY);
    return stored?.[LOCAL_ENABLED_KEY] === true;
  } catch {
    return false;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function collectJankPhaseSnapshot(phase, { reset = true } = {}) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const snapshots = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT',
        reset,
      });
      if (response?.ok) {
        snapshots.push({
          tabId: tab.id,
          windowId: tab.windowId,
          active: tab.active === true,
          details: response.details || null,
        });
      }
    } catch {}
  }
  return {
    captureId: phase.captureId || null,
    label: phase.label || phase.mode || 'unknown',
    mode: phase.mode || 'normal',
    startedAt: phase.changedAt || null,
    endedAt: new Date().toISOString(),
    tabs: snapshots,
  };
}

async function resetJankPhaseTelemetry() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT',
        reset: true,
      });
    } catch {}
  }
}

async function applyJankIsolationMode(mode = 'normal', {
  source = 'runtime',
  label = null,
  captureId = null,
} = {}) {
  const normalized = ['normal', 'cdp_off', 'content_off', 'high_level_off', 'runtime_off'].includes(mode) ? mode : 'normal';
  const previous = (await chrome.storage.local.get(JANK_ISOLATION_KEY))[JANK_ISOLATION_KEY] || { mode: 'normal' };
  const wasRuntimeOff = diagnosticRuntimeSuspended;
  const sameCapture = Boolean(captureId && previous.captureId === captureId);
  let completedPhase = null;
  if (sameCapture && previous.label && previous.label !== 'restore_normal') {
    completedPhase = await collectJankPhaseSnapshot(previous, { reset: true });
    logRuntime('info', 'diagnostics', 'jank_phase_snapshot', completedPhase);
  }

  const state = {
    mode: normalized,
    label: String(label || normalized).slice(0, 80),
    captureId: captureId ? String(captureId).slice(0, 120) : null,
    previousMode: previous.mode || 'normal',
    changedAt: new Date().toISOString(),
    source,
  };
  await chrome.storage.local.set({ [JANK_ISOLATION_KEY]: state });

  const runtimeOff = normalized === 'runtime_off';
  diagnosticRuntimeSuspended = runtimeOff;
  const cdpOff = normalized === 'cdp_off' || normalized === 'high_level_off' || runtimeOff;
  const contentOff = normalized === 'content_off' || normalized === 'high_level_off' || runtimeOff;
  const captureActive = Boolean(state.captureId && state.label !== 'restore_normal');
  if (runtimeOff && !wasRuntimeOff) await stopBackgroundRuntime('diagnostic_runtime_off');
  const cdp = await networkMonitor.setDiagnosticSuspended(cdpOff);
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  let contentTabs = 0;
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND',
        suspended: contentOff,
        captureActive,
      });
      if (response?.ok) contentTabs += 1;
    } catch {}
  }
  if (!runtimeOff && wasRuntimeOff) {
    await initializeAfterCurrentTask();
  } else if (!cdpOff) {
    await configureOpenTabs();
  }
  if (!sameCapture && state.captureId) await resetJankPhaseTelemetry();

  logRuntime('info', 'diagnostics', 'jank_isolation_changed', {
    ...state,
    runtimeSuspended: runtimeOff,
    cdpSuspended: cdp.suspended,
    detachedTabs: cdp.detachedTabs,
    contentSuspended: contentOff,
    contentTabs,
    captureActive,
    completedPhaseLabel: completedPhase?.label || null,
  });
  return {
    ...state,
    runtimeSuspended: runtimeOff,
    cdp,
    contentSuspended: contentOff,
    contentTabs,
    captureActive,
    completedPhase,
  };
}

let runtimeLogFlushTimer = null;
function scheduleRuntimeLogDelivery() {
  if (runtimeLogFlushTimer !== null) return;
  runtimeLogFlushTimer = setTimeout(() => {
    runtimeLogFlushTimer = null;
    // Browser storage is the canonical log. Native-file and server copies are delivery
    // sinks only; both consume the same immutable entry ids and acknowledge independently.
    void syncRuntimeLogsToNative().catch(() => {});
  }, 750);
}

function logRuntime(level, component, event, details = {}) {
  void appendRuntimeLog(level, component, event, details)
    .then(() => scheduleRuntimeLogDelivery())
    .catch(() => {});
}

async function startAutoVerificationStreamCapture(tabId, startedAt) {
  const capture = createDiagnosticSseCapture({ tabId, startedAt });
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: capture });
  return capture;
}

async function captureAutoVerificationStream(tabId, state, evidence) {
  const rawData = typeof evidence?.rawStreamData === 'string'
    ? evidence.rawStreamData
    : evidence?.rawResponseBody;
  const mimeType = String(evidence?.diagnostics?.mimeType || '');
  const bodyFormat = String(evidence?.diagnostics?.bodyFormat || '');
  const transport = evidence?.streamContext?.transport
    || evidence?.diagnostics?.transport
    || (/event-stream/i.test(mimeType) || bodyFormat.includes('sse') ? 'sse' : 'unknown');
  const isDownstream = Boolean(evidence?.streamContext?.isDownstream);
  if (!state.autoVerification?.running || typeof rawData !== 'string' || !rawData) return null;
  if (transport === 'unknown' && !isDownstream) return null;
  if (!isDownstream && state.lastRequest?.requestId && state.lastRequest.requestId !== evidence.requestId) return null;

  const stored = await chrome.storage.local.get(DIAGNOSTIC_SSE_STORAGE_KEY);
  let capture = stored[DIAGNOSTIC_SSE_STORAGE_KEY];
  if (!capture || capture.tabId !== tabId || capture.startedAt !== state.autoVerification.startedAt) {
    capture = createDiagnosticSseCapture({ tabId, startedAt: state.autoVerification.startedAt });
  }
  const beforeIncludedBytes = Number(capture.includedBytes || 0);
  const next = appendDiagnosticSseCapture(capture, {
    attempt: state.autoVerification.attempt ?? null,
    requestId: evidence.requestId ?? null,
    capturedAt: evidence.capturedAt ?? new Date().toISOString(),
    endpoint: evidence.diagnostics?.endpoint ?? null,
    httpStatus: evidence.diagnostics?.httpStatus ?? evidence.status ?? null,
    mimeType,
    bodyFormat,
    transport,
    direction: evidence?.streamContext?.direction ?? evidence?.diagnostics?.direction ?? 'received',
    stage: evidence?.streamContext?.stage ?? evidence?.diagnostics?.stage ?? null,
    streamContext: evidence?.streamContext ?? null,
    requestModel: state.lastRequest?.model ?? null,
    rewriteReason: state.lastRewrite?.reason ?? null,
    rawData,
  });
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: next });
  logRuntime(next.overflowed ? 'warn' : 'info', 'diagnostics', 'auto_verify_stream_captured', {
    tabId,
    attempt: state.autoVerification.attempt ?? null,
    requestId: evidence.requestId ?? null,
    transport,
    direction: evidence?.streamContext?.direction ?? evidence?.diagnostics?.direction ?? 'received',
    stage: evidence?.streamContext?.stage ?? evidence?.diagnostics?.stage ?? null,
    addedBytes: Math.max(0, Number(next.includedBytes || 0) - beforeIncludedBytes),
    includedBytes: next.includedBytes,
    totalBytes: next.totalBytes,
    maxBytes: next.maxBytes,
    overflowed: next.overflowed,
    omittedResponses: next.omittedResponses,
  });
  return next;
}

async function finalizeAutoVerificationStreamCapture(tabId, completedAt) {
  const stored = await chrome.storage.local.get(DIAGNOSTIC_SSE_STORAGE_KEY);
  let capture = stored[DIAGNOSTIC_SSE_STORAGE_KEY];
  const state = tabStates.get(tabId);
  if (!capture || capture.tabId !== tabId) {
    capture = createDiagnosticSseCapture({ tabId, startedAt: state?.autoVerification?.startedAt ?? null });
  }
  const finalized = finalizeDiagnosticSseCapture(capture, completedAt);
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: finalized });
  return finalized;
}

async function clearAutoVerificationStreamCapture() {
  await chrome.storage.local.remove(DIAGNOSTIC_SSE_STORAGE_KEY);
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function contextKey(value) {
  try {
    const url = new URL(value);
    const conversation = url.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)/);
    return conversation ? `conversation:${conversation[1]}` : `page:${url.pathname}`;
  } catch {
    return 'unknown';
  }
}

function createTabState(tabId, url = '') {
  return {
    tabId,
    url,
    windowId: null,
    contextKey: contextKey(url),
    core: coreConnection,
    monitor: { attached: false, error: null },
    phase: 'initial',
    probeUsed: false,
    probeArmed: false,
    pageObservation: null,
    lastRewrite: null,
    lastRequest: null,
    lastVerification: null,
    lastResponseEvidence: null,
    lastEvidenceDiagnostics: null,
    streamTracking: null,
    evidenceIssue: null,
    lastError: null,
    autoVerification: null,
    updatedAt: new Date().toISOString(),
  };
}

function ensureTabState(tabId, url = '') {
  let state = tabStates.get(tabId);
  if (!state) {
    state = createTabState(tabId, url);
    tabStates.set(tabId, state);
  } else if (url && state.contextKey !== contextKey(url)) {
    const nextContextKey = contextKey(url);
    const preserveVerificationState = Boolean(
      state.autoVerification?.running
        || (state.autoVerification && !state.contextKey.startsWith('conversation:') && nextContextKey.startsWith('conversation:')),
    );
    if (preserveVerificationState) {
      const previousContextKey = state.contextKey;
      state.url = url;
      state.contextKey = nextContextKey;
      logRuntime('info', 'verification', 'auto_verify_context_migrated', {
        tabId,
        previousContextKey,
        nextContextKey,
        running: Boolean(state.autoVerification?.running),
      });
    } else {
      const monitor = state.monitor;
      state = createTabState(tabId, url);
      state.monitor = monitor;
      tabStates.set(tabId, state);
    }
  } else if (url) {
    state.url = url;
  }
  return state;
}

function accountAllowsState(state) {
  if (!accountState?.authenticated || !accountState?.entitlement?.active) return false;
  const windowKey = Number.isInteger(state?.windowId) ? `chrome:${state.windowId}` : null;
  if (!windowKey) return true;
  const allowed = Array.isArray(accountState.allowedWindowKeys) ? accountState.allowedWindowKeys : [];
  const denied = Array.isArray(accountState.deniedWindowKeys) ? accountState.deniedWindowKeys : [];
  if (!allowed.length && !denied.length) return true;
  return allowed.includes(windowKey) && !denied.includes(windowKey);
}

function effectiveSettingsForState(state) {
  const verification = verificationTransactionForTab(state?.tabId);
  if (verification) {
    // Model verification is an isolated measurement transaction. User Work/model-lock
    // switches must not block the fixed probe or alter the model ChatGPT actually sends.
    return {
      ...currentSettings,
      enabled: true,
      networkVerificationEnabled: true,
      autoAlignSelection: false,
    };
  }
  return {
    ...currentSettings,
    enabled: Boolean(
      currentSettings.enabled
        && accountAllowsState(state)
        && tabFeatureEnabledSync(state?.tabId),
    ),
  };
}

function verificationTransactionForTab(tabId) {
  return verificationTransactions.get(Number(tabId)) || null;
}

function runtimePolicyForTabSync(tabId) {
  const policy = effectivePolicyForTabSync(tabId);
  const transaction = verificationTransactionForTab(tabId);
  return transaction?.model
    ? normalizePolicy({ ...policy, lockedModels: [transaction.model] })
    : policy;
}

function guardFor(state) {
  return evaluateGuard({
    state,
    policy: runtimePolicyForTabSync(state?.tabId),
    settings: effectiveSettingsForState(state),
    inScope: isChatGptUrl(state.url),
  });
}

function publicTabState(state) {
  if (!state) return null;
  return {
    contextKey: state.contextKey,
    core: state.core,
    monitor: state.monitor,
    phase: state.phase,
    probeUsed: state.probeUsed,
    probeArmed: state.probeArmed,
    pageObservation: state.pageObservation,
    lastRewrite: state.lastRewrite,
    lastRequest: state.lastRequest,
    lastVerification: state.lastVerification,
    lastResponseEvidence: state.lastResponseEvidence,
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
    knownModels: [...sharedKnownModelIds],
    updatedAt: state.updatedAt,
    guard: guardFor(state),
  };
}

async function updateTabBadge(state) {
  const guard = guardFor(state);
  let text = 'L';
  let color = '#2563eb';
  if (guard.status === 'verified') {
    text = 'OK';
    color = '#15803d';
  } else if (guard.status === 'mismatch' && !guard.canSend) {
    text = '!';
    color = '#b91c1c';
  } else if (guard.status === 'waiting') {
    text = '…';
    color = '#b45309';
  } else if (['monitor_offline', 'core_offline', 'error', 'unverified'].includes(guard.status)) {
    text = '?';
    color = '#b45309';
  } else if (guard.status === 'disabled') {
    text = 'OFF';
    color = '#64748b';
  }
  try {
    await chrome.action.setBadgeText({ tabId: state.tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId: state.tabId, color });
  } catch {
    // The tab may have closed between the event and the badge update.
  }
}

async function broadcastTabState(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return;
  if (!masterRuntimeEnabled()) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
    return;
  }
  state.updatedAt = new Date().toISOString();
  await updateTabBadge(state);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTLOCK_GUARD_STATE',
      state: publicTabState(state),
      policy: runtimePolicyForTabSync(tabId),
      settings: effectiveSettingsForState(state),
    });
  } catch {
    // A content script may not exist yet while a tab is loading.
  }
}

async function ensureConfiguration() {
  const [stored, localStored] = await Promise.all([
    chrome.storage.sync.get(['policy', 'settings', SHARED_KNOWN_MODELS_KEY]),
    chrome.storage.local.get(LOCAL_ENABLED_KEY),
  ]);
  sharedKnownModelIds = new Set(
    (Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [])
      .map((item) => normalizeConcreteModelId(item?.model))
      .filter(Boolean),
  );
  currentPolicy = normalizePolicy(stored.policy ?? DEFAULT_POLICY);
  const syncedSettings = normalizeSettings(stored.settings ?? DEFAULT_SETTINGS);
  localEnabledOverride = typeof localStored?.[LOCAL_ENABLED_KEY] === 'boolean'
    ? localStored[LOCAL_ENABLED_KEY]
    : syncedSettings.enabled;
  currentSettings = normalizeSettings({ ...syncedSettings, enabled: localEnabledOverride });
  if (typeof localStored?.[LOCAL_ENABLED_KEY] !== 'boolean') {
    await chrome.storage.local.set({ [LOCAL_ENABLED_KEY]: localEnabledOverride });
  }
  const patch = {};
  if (!stored.policy || JSON.stringify(stored.policy) !== JSON.stringify(currentPolicy)) patch.policy = currentPolicy;
  if (!stored.settings || JSON.stringify(stored.settings) !== JSON.stringify(syncedSettings)) patch.settings = syncedSettings;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  return { policy: currentPolicy, settings: currentSettings };
}

async function writeNativeStatus(patch) {
  const { nativeStatus = {} } = await chrome.storage.local.get('nativeStatus');
  const next = {
    connected: false,
    lastError: null,
    lastSeenAt: null,
    lastVerification: null,
    ...nativeStatus,
    ...patch,
  };
  if (Object.hasOwn(patch, 'lastError')) next.errorCode = classifyNativeError(patch.lastError);
  await chrome.storage.local.set({ nativeStatus: next });
  if (
    nativeStatus.connected !== next.connected
    || nativeStatus.lastError !== next.lastError
    || nativeStatus.version !== next.version
  ) {
    logRuntime(next.connected ? 'info' : 'warn', 'native', 'status_changed', {
      connected: next.connected,
      version: next.version ?? null,
      errorCode: next.errorCode ?? null,
      lastError: next.lastError ?? null,
    });
  }
  coreConnection = { connected: Boolean(next.connected), error: next.lastError ?? null };
  for (const state of tabStates.values()) {
    state.core = coreConnection;
    void broadcastTabState(state.tabId);
  }
  return next;
}

async function scheduleReconnect() {
  if (!await masterStorageEnabled()) return false;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
  return true;
}

function rejectPending(error) {
  for (const { reject, timer, type } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
    logRuntime('warn', 'native', 'request_rejected', { type, error: errorText(error) });
  }
  pendingRequests.clear();
}

async function markNativeStopped() {
  try {
    const { nativeStatus = {} } = await chrome.storage.local.get('nativeStatus');
    await chrome.storage.local.set({
      nativeStatus: {
        ...nativeStatus,
        connected: false,
        lastError: null,
        errorCode: null,
      },
    });
  } catch {}
  coreConnection = { connected: false, error: null };
  for (const state of tabStates.values()) state.core = coreConnection;
}

async function stopBackgroundRuntime(reason = 'master_disabled') {
  const port = nativePort;
  nativePort = null;
  rejectPending(new Error('GPTWork master disabled'));
  try { port?.disconnect(); } catch {}
  await Promise.allSettled([
    chrome.alarms.clear(RECONNECT_ALARM),
    chrome.alarms.clear(ACCOUNT_REFRESH_ALARM),
  ]);
  await markNativeStopped();
  for (const tabId of [...tabStates.keys()]) {
    try { await networkMonitor.detach(tabId); } catch {}
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
  }
  logRuntime('info', 'extension', 'background_runtime_stopped', { reason, tabs: tabStates.size });
}

function connectNative() {
  if (!masterRuntimeEnabled()) {
    throw Object.assign(new Error('GPTWork master disabled'), { code: 'MASTER_DISABLED' });
  }
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener((message) => {
      const pending = pendingRequests.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(String(message.id));
      if (message.ok) {
        pending.resolve(message.data);
      } else {
        const error = new Error(message.error?.messageZhCn || message.error?.messageEn || 'Native request failed');
        logRuntime('error', 'native', 'request_failed', {
          type: pending.type,
          code: message.error?.code ?? null,
          error: error.message,
        });
        pending.reject(error);
      }
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const detail = chrome.runtime.lastError?.message || 'Native host disconnected';
      nativePort = null;
      rejectPending(new Error(detail));
      if (masterRuntimeEnabled()) {
        void writeNativeStatus({ connected: false, lastError: detail });
        void scheduleReconnect();
        logRuntime('warn', 'native', 'disconnected', { error: detail });
      } else {
        void markNativeStopped();
      }
    });
    void writeNativeStatus({ connected: true, lastError: null, lastSeenAt: new Date().toISOString() });
    return port;
  } catch (error) {
    const detail = errorText(error);
    if (masterRuntimeEnabled()) {
      void writeNativeStatus({ connected: false, lastError: detail });
      void scheduleReconnect();
      logRuntime('error', 'native', 'connect_failed', { error: detail });
    }
    throw error;
  }
}

function sendNative(type, payload = {}) {
  if (!masterRuntimeEnabled()) {
    return Promise.reject(Object.assign(new Error('GPTWork master disabled'), { code: 'MASTER_DISABLED' }));
  }
  const port = connectNative();
  const id = `${Date.now()}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`Native request timed out: ${type}`);
      logRuntime('error', 'native', 'request_timeout', { type, timeoutMs: REQUEST_TIMEOUT_MS });
      reject(error);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, type });
    try {
      port.postMessage({ id, type, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      logRuntime('error', 'native', 'post_message_failed', { type, error: errorText(error) });
      reject(error);
    }
  });
}

let nativeLogSyncQueue = Promise.resolve();
async function syncRuntimeLogsToNative() {
  nativeLogSyncQueue = nativeLogSyncQueue.catch(() => {}).then(async () => {
    if (!masterRuntimeEnabled()) return { written: 0, skipped: 'master_disabled' };
    let total = 0;
  // Drain several small batches without blocking ordinary verification messages for long.
  for (let pass = 0; pass < 40; pass += 1) {
    const records = await runtimeLogNativeBatch(50);
    if (!records.length) break;
    const result = await sendNative('append_runtime_logs', { records });
    const written = Number(result?.written || 0);
    if (written <= 0) break;
    await markRuntimeLogsNative(records.slice(0, written).map((entry) => entry.id));
    total += written;
    if (records.length < 50) break;
  }
    return { written: total };
  });
  return nativeLogSyncQueue;
}

async function syncPolicy() {
  const result = await sendNative('set_policy', { policy: currentPolicy });
  await writeNativeStatus({
    connected: true,
    lastError: null,
    lastSeenAt: new Date().toISOString(),
    policyRevision: result.revision,
  });
  return result;
}

async function verifyObservation(observation, policy = currentPolicy) {
  const result = await sendNative('verify', {
    policy,
    observation: {
      model: observation.model ?? null,
      reasoning: observation.reasoning ?? null,
      evidenceSource: observation.evidenceSource,
      capturedAt: observation.capturedAt ?? new Date().toISOString(),
      requestId: observation.requestId || `extension-${Date.now()}-${++requestSequence}`,
    },
  });
  await writeNativeStatus({
    connected: true,
    lastError: null,
    lastSeenAt: new Date().toISOString(),
    lastVerification: result,
    policyRevision: result.policyRevision,
  });
  return result;
}

function responseEvidenceRequestId(evidence) {
  return evidence?.streamContext?.initialRequestId
    || evidence?.requestId
    || null;
}

function mergeResponseEvidence(state, evidence) {
  const requestId = responseEvidenceRequestId(evidence)
    || state.lastRequest?.requestId
    || null;
  // A response observation is authoritative only for the evidence carried by that
  // observation. Never inherit a previously observed model into a later packet
  // that contains zero model candidates: that manufactured stale Sol mismatches
  // in v0.5.133 after the actual request had moved to GPT-6 Sol.
  const currentHasModelAuthority = Boolean(
    evidence?.model
      || evidence?.conflicts?.model
      || Number(evidence?.diagnostics?.modelCandidateCount || 0) > 0
  );
  const previous = state.lastResponseEvidence?.requestId === requestId
    ? state.lastResponseEvidence
    : null;
  const previousModel = currentHasModelAuthority ? previous?.model : null;
  const previousModelConflict = currentHasModelAuthority ? previous?.conflicts?.model : false;
  const modelConflict = Boolean(
    evidence?.conflicts?.model
      || previousModelConflict
      || (previousModel && evidence?.model && previousModel !== evidence.model),
  );
  const reasoningConflict = Boolean(
    evidence?.conflicts?.reasoning
      || previous?.conflicts?.reasoning
      || (previous?.reasoning && evidence?.reasoning && previous.reasoning !== evidence.reasoning),
  );
  const merged = {
    requestId,
    capturedAt: evidence?.capturedAt ?? previous?.capturedAt ?? new Date().toISOString(),
    model: modelConflict ? null : evidence?.model || previousModel || null,
    reasoning: reasoningConflict ? null : evidence?.reasoning || previous?.reasoning || null,
    conflicts: { model: modelConflict, reasoning: reasoningConflict },
    fields: {
      model: evidence?.fields?.model || (currentHasModelAuthority ? previous?.fields?.model : null) || null,
      reasoning: evidence?.fields?.reasoning || previous?.fields?.reasoning || null,
    },
    bodyError: evidence?.bodyError || previous?.bodyError || null,
    evidenceSource: 'network_response_metadata',
    diagnostics: evidence?.diagnostics ?? previous?.diagnostics ?? null,
    streamContext: evidence?.streamContext ?? previous?.streamContext ?? null,
  };
  state.lastResponseEvidence = merged;
  return merged;
}

function verificationResponseObservation(tabId, responseEvidence) {
  const transaction = verificationTransactionForTab(tabId);
  const target = normalizeConcreteModelId(transaction?.model);
  const observed = normalizeConcreteModelId(responseEvidence?.model);
  const field = String(responseEvidence?.fields?.model || '');
  // default_model_slug describes a fallback/default and is not proof of the model
  // that served this turn. In contrast resolved/served/used model fields describe
  // backend execution and MUST remain authoritative for strict page=request=response
  // verification. A mismatch there is a real mismatch, not evidence to hide.
  const weakDefaultOnly = /(?:^|\.)default_model_slug$/i.test(field);
  if (observed && weakDefaultOnly) {
    return {
      model: null,
      backendResolvedModel: observed,
      downgraded: true,
      reason: 'default_model_not_served_model',
    };
  }
  return {
    model: responseEvidence?.conflicts?.model ? null : observed,
    backendResolvedModel: target && observed && observed !== target ? observed : null,
    downgraded: false,
    reason: target && observed && observed !== target ? 'served_model_mismatch' : null,
  };
}

function diagnoseEvidenceIssue(evidence, result) {
  if (evidence.bodyError) return 'response_body_read_failed';
  if (evidence.conflicts?.model || evidence.conflicts?.reasoning) return 'response_metadata_conflict';
  const format = evidence.diagnostics?.bodyFormat;
  if (format === 'empty') return 'response_body_empty';
  if (format === 'too_large') return 'response_body_too_large';
  if (format === 'unparsed') return 'response_body_unparseable';
  if (result.reason === 'model_missing') return 'response_model_not_exposed';
  if (result.reason === 'reasoning_missing') return 'response_reasoning_not_exposed';
  return result.verdict === 'verified' ? null : 'response_metadata_incomplete';
}

async function applyNetworkEvidence(tabId, evidence) {
  const state = ensureTabState(tabId);
  const evidenceRequestId = responseEvidenceRequestId(evidence);
  const currentRequestId = state.lastRequest?.requestId || null;
  if (currentRequestId && evidenceRequestId && evidenceRequestId !== currentRequestId) {
    logRuntime('info', 'network', 'response_evidence_ignored_stale_request', {
      tabId,
      currentRequestId,
      evidenceRequestId,
      transport: evidence?.streamContext?.transport || evidence?.diagnostics?.transport || null,
    });
    evidence.rawResponseBody = null;
    return;
  }
  const handoff = evidence?.diagnostics?.streamHandoff;
  if (handoff) {
    state.streamTracking = {
      detectedAt: Date.now(),
      lastActivityAt: Date.now(),
      downstreamEvidenceCount: 0,
      transports: [],
      handoff,
    };
    logRuntime('info', 'network', 'stream_handoff_detected', { tabId, handoff });
  }
  if (evidence?.streamContext?.isDownstream) {
    const tracking = state.streamTracking || {
      detectedAt: Date.now(),
      lastActivityAt: Date.now(),
      downstreamEvidenceCount: 0,
      transports: [],
      handoff: null,
    };
    tracking.lastActivityAt = Date.now();
    tracking.downstreamEvidenceCount += 1;
    const transport = evidence.streamContext.transport || evidence?.diagnostics?.transport || 'unknown';
    if (!tracking.transports.includes(transport)) tracking.transports.push(transport);
    state.streamTracking = tracking;
  }
  try {
    await captureAutoVerificationStream(tabId, state, evidence);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_failed', { tabId, error: errorText(error) });
  } finally {
    evidence.rawResponseBody = null;
  }
  const responseEvidence = mergeResponseEvidence(state, evidence);
  state.lastEvidenceDiagnostics = responseEvidence.diagnostics ?? null;
  if (!masterRuntimeEnabled()) return;

  // Downstream generation can emit many packets carrying the same served-model
  // metadata. Once this exact request is verified, keep that terminal proof unless a
  // later packet introduces contradictory model/reasoning evidence.
  const verificationRequestId = responseEvidence.requestId
    ? `cdp-${tabId}-${responseEvidence.requestId}`
    : null;
  const directModel = normalizeConcreteModelId(evidence?.model);
  const directReasoning = normalizeReasoningLevel(evidence?.reasoning);
  const priorVerified = state.lastVerification?.verdict === 'verified'
    && verificationRequestId
    && state.lastVerification?.requestId === verificationRequestId;
  const addsContradiction = Boolean(
    evidence?.conflicts?.model
      || evidence?.conflicts?.reasoning
      || (directModel && normalizeConcreteModelId(state.lastVerification?.model) !== directModel)
      || (directReasoning && normalizeReasoningLevel(state.lastVerification?.reasoning) !== directReasoning)
  );
  if (priorVerified && !addsContradiction) return;

  try {
    const modelObservation = verificationResponseObservation(tabId, responseEvidence);
    if (modelObservation.downgraded) {
      responseEvidence.diagnostics = {
        ...(responseEvidence.diagnostics || {}),
        backendResolvedModel: modelObservation.backendResolvedModel,
        selectedModelEvidenceDowngraded: true,
        selectedModelEvidenceReason: modelObservation.reason,
      };
      state.lastEvidenceDiagnostics = responseEvidence.diagnostics;
      logRuntime('info', 'verification', 'backend_model_resolution_observed', {
        tabId,
        verificationModel: verificationTransactionForTab(tabId)?.model ?? null,
        backendResolvedModel: modelObservation.backendResolvedModel,
        field: responseEvidence.fields?.model ?? null,
      });
    }
    const result = await verifyObservation({
      model: modelObservation.model,
      reasoning: responseEvidence.conflicts?.reasoning ? null : responseEvidence.reasoning,
      evidenceSource: 'network_response_metadata',
      capturedAt: responseEvidence.capturedAt,
      requestId: `cdp-${tabId}-${responseEvidence.requestId || evidence.requestId}`,
    }, runtimePolicyForTabSync(tabId));
    state.lastVerification = result;
    state.evidenceIssue = diagnoseEvidenceIssue(responseEvidence, result);
    state.lastError = responseEvidence.bodyError || (responseEvidence.conflicts?.model || responseEvidence.conflicts?.reasoning
      ? 'conflicting_response_metadata'
      : null);
    state.phase = result.verdict;
    logRuntime(result.verdict === 'verified' ? 'info' : 'warn', 'verification', 'response_evaluated', {
      tabId,
      requestId: evidence?.streamContext?.initialRequestId ?? evidence.requestId ?? null,
      verdict: result.verdict,
      decision: result.decision,
      reason: result.reason,
      reasons: result.reasons,
      model: result.model,
      reasoning: result.reasoning,
      evidenceSource: result.evidenceSource,
      evidenceIssue: state.evidenceIssue,
      diagnostics: responseEvidence.diagnostics ?? null,
    });
  } catch (error) {
    state.phase = 'error';
    state.evidenceIssue = 'verification_request_failed';
    state.lastError = errorText(error);
    logRuntime('error', 'verification', 'response_evaluation_failed', {
      tabId,
      requestId: evidence?.streamContext?.initialRequestId ?? evidence.requestId ?? null,
      error: state.lastError,
      diagnostics: evidence.diagnostics ?? null,
    });
  }
  await broadcastTabState(tabId);
}

const networkMonitor = new ChatGptNetworkMonitor({
  getLockConfiguration(tabId) {
    const policy = runtimePolicyForTabSync(tabId);
    return {
      lockedModels: policy.lockedModels,
      allowedReasoningLevels: policy.allowedReasoningLevels,
      preferredReasoning: currentSettings.preferredReasoning,
      preserveModel: false,
      preserveReasoning: false,
      bypassRewrite: false,
      forceModel: null,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
      knownModels: [...sharedKnownModelIds],
    };
  },
  getVerificationTransaction(tabId) {
    const transaction = verificationTransactionForTab(tabId);
    if (!transaction?.model) return null;
    return {
      model: transaction.model,
      startedAt: transaction.startedAt ?? null,
    };
  },
  onStatus(tabId, monitor) {
    const state = ensureTabState(tabId);
    state.monitor = monitor;
    if (!monitor.attached && state.phase === 'waiting') {
      state.phase = 'error';
      state.lastError = monitor.error || 'request_lock_monitor_detached';
    }
    logRuntime(monitor.attached ? 'info' : 'warn', 'network', 'monitor_status', {
      tabId,
      attached: monitor.attached,
      error: monitor.error,
    });
    void broadcastTabState(tabId);
  },
  onRewrite(tabId, rewrite) {
    const state = ensureTabState(tabId);
    state.lastRewrite = {
      capturedAt: new Date().toISOString(),
      endpoint: rewrite.endpoint ?? null,
      requestId: rewrite.requestId ?? null,
      fetchRequestId: rewrite.fetchRequestId ?? null,
      changed: Boolean(rewrite.changed),
      reason: rewrite.reason ?? null,
      modelBefore: rewrite.modelBefore ?? null,
      modelAfter: rewrite.modelAfter ?? null,
      transportModelBefore: rewrite.transportModelBefore ?? null,
      transportModelAfter: rewrite.transportModelAfter ?? null,
      reasoningBefore: rewrite.reasoningBefore ?? null,
      reasoningAfter: rewrite.reasoningAfter ?? null,
      reasoningFields: rewrite.reasoningFields ?? [],
      authorityKind: rewrite.authorityKind ?? null,
      authorityModel: rewrite.authorityModel ?? null,
      authorityStartedAt: rewrite.authorityStartedAt ?? null,
      error: rewrite.error ?? null,
    };
    if (rewrite.error) state.lastError = rewrite.error;
    const verification = verificationTransactionForTab(tabId);
    if (verification?.model && rewrite.authorityKind !== 'verification-transaction') {
      state.lastError = 'verification_request_missing_terminal_authority';
      state.phase = 'error';
      logRuntime('error', 'verification', 'verification_request_generation_or_authority_mismatch', {
        tabId,
        verificationModel: verification.model,
        rewriteAuthorityKind: rewrite.authorityKind ?? null,
        rewriteAuthorityModel: rewrite.authorityModel ?? null,
        modelAfter: rewrite.modelAfter ?? null,
        fetchRequestId: rewrite.fetchRequestId ?? null,
      });
    }
    logRuntime(rewrite.error ? 'warn' : 'info', 'lock', rewrite.changed ? 'request_lock_rewritten' : 'request_lock_checked', {
      tabId,
      verificationActive: Boolean(verification),
      verificationModel: verification?.model ?? null,
      ...state.lastRewrite,
    });
    void broadcastTabState(tabId);
  },
  onRequest(tabId, request) {
    const state = ensureTabState(tabId);
    state.lastRequest = {
      requestId: request.requestId,
      capturedAt: request.capturedAt,
      model: request.model,
      reasoning: request.reasoning,
      diagnostics: request.diagnostics ?? null,
    };
    state.probeUsed = true;
    state.probeArmed = false;
    if (currentSettings.networkVerificationEnabled) state.phase = 'waiting';
    state.lastError = request.conflicts?.model || request.conflicts?.reasoning
      ? 'conflicting_request_metadata'
      : null;
    state.evidenceIssue = null;
    state.lastResponseEvidence = null;
    state.lastEvidenceDiagnostics = null;
    logRuntime('info', 'network', 'formal_conversation_request_detected', {
      tabId,
      requestId: request.requestId,
      model: request.model,
      reasoning: request.reasoning,
      conflicts: request.conflicts,
      fields: request.fields,
      diagnostics: request.diagnostics,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    });
    void broadcastTabState(tabId);
  },
  onEvidence(tabId, evidence) {
    void applyNetworkEvidence(tabId, evidence);
  },
  onStreamData(tabId, streamData) {
    const state = ensureTabState(tabId);
    if (streamData?.streamContext?.isDownstream) {
      const tracking = state.streamTracking || {
        detectedAt: Date.now(),
        lastActivityAt: Date.now(),
        downstreamEvidenceCount: 0,
        transports: [],
        handoff: null,
      };
      tracking.lastActivityAt = Date.now();
      const transport = streamData.streamContext.transport || streamData?.diagnostics?.transport || 'unknown';
      if (!tracking.transports.includes(transport)) tracking.transports.push(transport);
      state.streamTracking = tracking;
    }
    void captureAutoVerificationStream(tabId, state, streamData).catch((error) => {
      logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_failed', { tabId, error: errorText(error) });
    });
  },
  onFailure(tabId, failure) {
    logRuntime('error', 'network', 'response_loading_failed', {
      tabId,
      endpoint: failure.endpoint,
      httpStatus: failure.httpStatus,
      canceled: failure.canceled,
      error: failure.error,
    });
    if (failure.downstream || !masterRuntimeEnabled()) return;
    void applyNetworkEvidence(tabId, {
      requestId: failure.requestId,
      capturedAt: new Date().toISOString(),
      model: null,
      reasoning: null,
      conflicts: { model: false, reasoning: false },
      bodyError: failure.error,
      diagnostics: {
        endpoint: failure.endpoint,
        httpStatus: failure.httpStatus,
        bodyLength: 0,
        bodyFormat: 'empty',
        parsedObjectCount: 0,
      },
    });
  },
});

async function configureTab(tab) {
  if (!tab?.id || !isChatGptUrl(tab.url ?? '')) return;
  const state = ensureTabState(tab.id, tab.url);
  state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;
  if (!masterRuntimeEnabled()) {
    await networkMonitor.detach(tab.id);
    try { await chrome.action.setBadgeText({ tabId: tab.id, text: '' }); } catch {}
    return state;
  }
  const enabled = effectiveSettingsForState(state).enabled;
  // Navigation from / to /c/:id is part of a new-chat verification turn. Detaching
  // CDP while ChatGPT creates that conversation loses the first formal request.
  if (verificationTransactionForTab(tab.id)) await networkMonitor.attach(tab.id);
  else if (!enabled || tab.status === 'loading') await networkMonitor.detach(tab.id);
  else await networkMonitor.attach(tab.id);
  await broadcastTabState(tab.id);
  return state;
}

async function configureOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  // Keep browser-wide debugger work bounded. Concurrent account/window refreshes may
  // share per-tab single-flight tasks in ChatGptNetworkMonitor, while each sweep itself
  // advances one tab at a time instead of attaching every window in a Promise.all burst.
  for (const tab of tabs) await configureTab(tab);
}

async function refreshAccountHeartbeat({ reconfigure = true } = {}) {
  if (!accountClient.hasSession()) {
    accountState = accountClient.snapshot();
    if (reconfigure) await configureOpenTabs();
    return accountState;
  }
  const chatTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const windowKeys = [...new Set(chatTabs
    .filter((tab) => Number.isInteger(tab.windowId))
    .map((tab) => `chrome:${tab.windowId}`))];
  try {
    accountState = await accountClient.heartbeat(windowKeys);
    if (accountState?.authenticated === true) {
      void syncSharedKnownModels();
      await applyServerFeatureSettings();
    }
  } catch (error) {
    accountState = { ...accountClient.snapshot(), lastError: errorText(error) };
  }
  if (reconfigure) await configureOpenTabs();
  return accountState;
}

async function applyServerFeatureSettings() {
  if (!accountClient.hasSession()) return null;
  try {
    const data = await accountClient.clientControl();
    const remote = data?.control?.featureSettings;
    if (!remote) return null;
    const nextSettings = normalizeSettings({
      ...currentSettings,
      networkVerificationEnabled: remote.responseVerificationEnabled !== false,
      autoAlignSelection: remote.autoAlignSelection !== false,
    });
    const nextPolicy = normalizePolicy({ ...currentPolicy, strictMode: remote.strictMode === true });
    const settingsChanged = JSON.stringify(nextSettings) !== JSON.stringify(currentSettings);
    const policyChanged = JSON.stringify(nextPolicy) !== JSON.stringify(currentPolicy);
    const local = await chrome.storage.local.get(RUNTIME_LOG_SYNC_KEY);
    const runtimeLogSyncEnabled = remote.runtimeLogSyncEnabled === true;
    const logSyncChanged = local[RUNTIME_LOG_SYNC_KEY] !== runtimeLogSyncEnabled;
    if (settingsChanged || policyChanged) {
      await chrome.storage.sync.set({ settings: nextSettings, policy: nextPolicy });
      currentSettings = nextSettings;
      currentPolicy = nextPolicy;
    }
    if (logSyncChanged) {
      await chrome.storage.local.set({ [RUNTIME_LOG_SYNC_KEY]: runtimeLogSyncEnabled });
    }
    if (settingsChanged || policyChanged || logSyncChanged) {
      logRuntime('info', 'settings', 'server_client_settings_applied', {
        generation: remote.generation ?? null,
        responseVerificationEnabled: nextSettings.networkVerificationEnabled,
        autoAlignSelection: nextSettings.autoAlignSelection,
        strictMode: nextPolicy.strictMode,
        runtimeLogSyncEnabled,
      });
    }
    return remote;
  } catch (error) {
    logRuntime('warn', 'settings', 'server_client_settings_fetch_failed', { error: errorText(error) });
    return null;
  }
}

async function refreshNativeCore({ tolerateFailure = false } = {}) {
  if (!masterRuntimeEnabled()) {
    await markNativeStopped();
    return { connected: false, error: null, status: null, reason: 'master_disabled' };
  }
  try {
    await sendNative('ping');
    await syncPolicy();
    const status = await sendNative('get_status');
    await writeNativeStatus({
      connected: true,
      lastError: null,
      lastSeenAt: new Date().toISOString(),
      lastVerification: status.lastVerification ?? null,
      policyRevision: status.policyRevision,
      version: status.version,
    });
    return { connected: true, error: null, status };
  } catch (error) {
    const detail = errorText(error);
    await writeNativeStatus({ connected: false, lastError: detail });
    if (!tolerateFailure) throw error;
    return { connected: false, error: detail, status: null };
  }
}

async function performInitialize() {
  const manifestVersion = chrome.runtime.getManifest().version;
  if (manifestVersion !== RUNTIME_CODE_VERSION) {
    await chrome.storage.local.set({
      gptworkGenerationMismatch: {
        manifestVersion,
        runtimeCodeVersion: RUNTIME_CODE_VERSION,
        detectedAt: new Date().toISOString(),
      },
    }).catch(() => {});
    // An unpacked extension can have its directory atomically replaced while the old
    // service worker is still alive. Never run a mixed generation: reload the whole
    // extension before attaching CDP or rewriting any request.
    chrome.runtime.reload();
    return;
  }
  logRuntime('info', 'extension', 'initialize_started', {
    version: manifestVersion,
    runtimeCodeVersion: RUNTIME_CODE_VERSION,
  });
  accountState = await accountClient.initialize();
  await ensureConfiguration();
  if (!masterRuntimeEnabled()) {
    await stopBackgroundRuntime('initialize_master_disabled');
    await configureOpenTabs();
    logRuntime('info', 'extension', 'initialize_completed', {
      enabled: false,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
      coreConnected: false,
      accountAuthenticated: Boolean(accountState?.authenticated),
      reason: 'master_disabled',
    });
    return;
  }
  await refreshNativeCore({ tolerateFailure: true });
  await refreshAccountHeartbeat({ reconfigure: false });
  await configureOpenTabs();
  chrome.alarms.create(ACCOUNT_REFRESH_ALARM, { periodInMinutes: 1 });
  logRuntime('info', 'extension', 'initialize_completed', {
    enabled: currentSettings.enabled,
    responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    coreConnected: coreConnection.connected,
    accountAuthenticated: Boolean(accountState?.authenticated),
  });
}

function initialize() {
  if (initializeTask) return initializeTask;
  initializeTask = performInitialize().finally(() => {
    initializeTask = null;
  });
  return initializeTask;
}

async function refreshMasterRuntimeStateFromStorage() {
  const stored = await chrome.storage.local.get(LOCAL_ENABLED_KEY);
  const nextEnabled = stored?.[LOCAL_ENABLED_KEY];
  if (typeof nextEnabled === 'boolean') {
    localEnabledOverride = nextEnabled;
    currentSettings = normalizeSettings({ ...currentSettings, enabled: nextEnabled });
  }
  return masterRuntimeEnabled();
}

export async function initializeAfterCurrentTask({ refreshMasterFromStorage = false } = {}) {
  const current = initializeTask;
  if (current) {
    try { await current; } catch {}
  }
  // Update recovery writes Master=ON to storage before asking this lifecycle authority
  // to reconnect. Do not depend on storage.onChanged winning that race.
  if (refreshMasterFromStorage) await refreshMasterRuntimeStateFromStorage();
  if (!masterRuntimeEnabled()) return;
  await initialize();
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function chatGptTabId(preferred = null) {
  if (Number.isInteger(preferred)) {
    const tab = await chrome.tabs.get(preferred);
    if (isChatGptUrl(tab.url ?? '')) return preferred;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && isChatGptUrl(active.url ?? '')) return active.id;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
  return tabs[0]?.id ?? null;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (response?.ok === false) reject(new Error(response.error || 'Page request failed'));
      else resolve(response);
    });
  });
}

function getPlatformInfo() {
  return new Promise((resolve) => {
    chrome.runtime.getPlatformInfo((info) => resolve(info ?? {}));
  });
}

async function collectPageObservation(tabId, state) {
  try {
    const response = await sendTabMessage(tabId, { type: 'GPTLOCK_COLLECT_PAGE_STATE' });
    if (response?.observation) {
      const observation = response.observation;
      state.pageObservation = {
        model: observation.model ?? null,
        reasoning: observation.reasoning ?? null,
        capturedAt: observation.capturedAt ?? new Date().toISOString(),
        evidenceSource: 'page_dom',
        modelEvidenceSource: observation.modelEvidenceSource ?? 'none',
        reasoningEvidenceSource: observation.reasoningEvidenceSource ?? 'none',
        modelLabel: observation.modelLabel ?? '',
        reasoningLabel: observation.reasoningLabel ?? '',
        ambiguousModel: Boolean(observation.ambiguousModel),
        candidates: Array.isArray(observation.candidates) ? observation.candidates.slice(0, 8) : [],
      };
      return { collected: true, error: null };
    }
    return { collected: false, error: 'page_observation_missing' };
  } catch (error) {
    return { collected: false, error: errorText(error) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetVerificationAttempt(state) {
  state.phase = 'initial';
  state.probeUsed = false;
  state.probeArmed = false;
  state.lastRewrite = null;
  state.lastRequest = null;
  state.lastVerification = null;
  state.lastResponseEvidence = null;
  state.lastEvidenceDiagnostics = null;
  state.streamTracking = null;
  state.evidenceIssue = null;
  state.lastError = null;
}

async function waitForAttemptVerification(tabId, startedAtMs) {
  const deadline = Date.now() + AUTO_VERIFY_RESPONSE_TIMEOUT_MS;
  let requestId = null;
  while (Date.now() < deadline) {
    const state = ensureTabState(tabId);
    const requestTime = Date.parse(state.lastRequest?.capturedAt || '');
    if (
      state.lastRequest?.requestId
      && Number.isFinite(requestTime)
      && requestTime >= startedAtMs - 1500
    ) requestId = state.lastRequest.requestId;

    if (
      requestId
      && state.lastVerification?.verdict === 'verified'
      && state.lastVerification?.requestId === `cdp-${tabId}-${requestId}`
    ) {
      return { timedOut: false, requestId, verified: true };
    }
    const tracking = state.streamTracking;
    if (requestId && tracking?.handoff) {
      const detectedAt = Number(tracking.detectedAt || 0);
      const lastActivityAt = Number(tracking.lastActivityAt || detectedAt);
      if (
        detectedAt
        && Date.now() - detectedAt >= AUTO_VERIFY_HANDOFF_MIN_WAIT_MS
        && Date.now() - lastActivityAt >= AUTO_VERIFY_HANDOFF_IDLE_MS
      ) {
        return {
          timedOut: false,
          requestId,
          handoffSettled: true,
          downstreamEvidenceCount: tracking.downstreamEvidenceCount || 0,
        };
      }
    } else if (
      requestId
      && state.lastVerification?.requestId === `cdp-${tabId}-${requestId}`
    ) {
      return { timedOut: false, requestId };
    }
    if (state.phase === 'error' && state.lastError) {
      return { timedOut: false, requestId, error: state.lastError };
    }
    await sleep(AUTO_VERIFY_POLL_MS);
  }
  return { timedOut: true, requestId };
}

function parseModelNameMappings(text, rawIds) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    const allowedRaw = new Set(rawIds);
    return (Array.isArray(parsed?.mappings) ? parsed.mappings : [])
      .map((item) => ({
        raw: String(item?.raw || '').trim().toLowerCase(),
        canonical: normalizeConcreteModelId(item?.canonical),
        displayName: String(item?.displayName || '').trim().slice(0, 120),
      }))
      .filter((item) => allowedRaw.has(item.raw) && item.canonical);
  } catch {
    return [];
  }
}

async function resolveUnknownCatalogNames(tabId, rows) {
  const unresolved = rows.filter((item) => {
    const raw = String(item?.rawId || '').trim().toLowerCase();
    const canonical = normalizeConcreteModelId(item?.model || raw);
    return raw && raw === canonical && /(?:-wm|preview|experimental|beta)$/i.test(raw);
  });
  if (!unresolved.length) return [];
  const rawIds = [...new Set(unresolved.map((item) => String(item.rawId).trim().toLowerCase()))];
  const prompt = [
    'GPTWork 模型名称解析：下面是从当前 ChatGPT 账户模型元数据自动发现、但 GPTWork 尚未定义显示名称的原始 model ID：',
    rawIds.join(', '),
    '请仅返回 JSON，不要解释。格式：{"mappings":[{"raw":"原始ID","canonical":"稳定的规范model ID","displayName":"ChatGPT界面正式模型名称"}]}。',
    '如果无法确定，canonical 请保持与 raw 完全相同，不要猜测。',
  ].join('\n');
  try {
    const result = await sendTabMessage(tabId, { type: 'GPTLOCK_AUTO_RESOLVE_MODEL_NAMES', prompt });
    const mappings = parseModelNameMappings(result?.responseText, rawIds);
    if (mappings.length) {
      const stored = await chrome.storage.sync.get('gptworkModelNameMappingsV1');
      const previous = stored.gptworkModelNameMappingsV1 && typeof stored.gptworkModelNameMappingsV1 === 'object'
        ? stored.gptworkModelNameMappingsV1
        : {};
      const next = { ...previous };
      for (const item of mappings) next[item.raw] = { canonical: item.canonical, displayName: item.displayName, learnedAt: new Date().toISOString() };
      await chrome.storage.sync.set({ gptworkModelNameMappingsV1: next });
    }
    logRuntime('info', 'verification', 'model_name_fallback_completed', { tabId, rawIds, mappings });
    return mappings;
  } catch (error) {
    logRuntime('warn', 'verification', 'model_name_fallback_failed', { tabId, rawIds, error: errorText(error) });
    return [];
  }
}

async function syncSharedKnownModels() {
  if (Date.now() < sharedModelCatalogUnavailableUntil) {
    const stored = await chrome.storage.sync.get(SHARED_KNOWN_MODELS_KEY);
    return Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [];
  }
  try {
    const result = await accountClient.sharedModelCatalog();
    const models = (Array.isArray(result?.models) ? result.models : [])
      .map((item) => ({
        model: normalizeConcreteModelId(item?.model),
        label: String(item?.label || '').trim().slice(0, 120),
        pickerMode: ['A', 'B'].includes(item?.pickerMode) ? item.pickerMode : null,
        verifiedCount: Math.max(0, Number(item?.verifiedCount || 0)),
        lastSeenAt: item?.lastSeenAt || null,
      }))
      .filter((item) => item.model);
    const stored = await chrome.storage.sync.get(SHARED_KNOWN_MODELS_KEY);
    const previous = Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [];
    sharedKnownModelIds = new Set(models.map((item) => item.model).filter(Boolean));
    if (JSON.stringify(previous) !== JSON.stringify(models)) {
      await chrome.storage.sync.set({ [SHARED_KNOWN_MODELS_KEY]: models });
      logRuntime('info', 'verification', 'shared_model_catalog_synced', { count: models.length, changed: true });
    }
    return models;
  } catch (error) {
    const unsupported = Number(error?.status) === 404 || /not found/i.test(errorText(error));
    if (unsupported) sharedModelCatalogUnavailableUntil = Date.now() + 5 * 60 * 1000;
    logRuntime(unsupported ? 'info' : 'warn', 'verification', unsupported ? 'shared_model_catalog_unavailable' : 'shared_model_catalog_sync_failed', {
      error: errorText(error), retryAfterMs: unsupported ? 5 * 60 * 1000 : 0,
    });
    const stored = await chrome.storage.sync.get(SHARED_KNOWN_MODELS_KEY);
    const cached = Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [];
    sharedKnownModelIds = new Set(cached.map((item) => normalizeConcreteModelId(item?.model)).filter(Boolean));
    return cached;
  }
}

function mergeAccountCatalogs(...catalogs) {
  const rows = [];
  const seen = new Set();
  const models = new Set();
  const reasoningLevels = new Set();
  let pickerMode = null;
  for (const catalog of catalogs.filter(Boolean)) {
    if (['A', 'B'].includes(catalog?.pickerMode)) pickerMode = catalog.pickerMode;
    for (const level of catalog?.reasoningLevels || []) reasoningLevels.add(level);
    for (const row of catalog?.rows || []) {
      const model = normalizeConcreteModelId(row?.model || row?.rawId);
      const selectorKey = String(row?.selectorKey || '').trim();
      const label = String(row?.label || '').trim();
      const key = model ? 'model:' + model : selectorKey ? 'selector:' + selectorKey : 'label:' + label;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (model) models.add(model);
      rows.push({ ...row, pickerMode: row?.pickerMode || catalog?.pickerMode || null });
    }
  }
  return { rows, models: [...models], reasoningLevels: [...reasoningLevels], pickerMode };
}

async function publishVerifiedModels(progress) {
  const models = (Array.isArray(progress?.results) ? progress.results : [])
    .filter((item) => item?.requestConfirmed === true && normalizeConcreteModelId(item?.model))
    .map((item) => ({
      model: normalizeConcreteModelId(item.model),
      label: String(item.label || item.model).trim().slice(0, 120),
      pickerMode: ['A', 'B'].includes(item.pickerMode) ? item.pickerMode : null,
      requestConfirmed: true,
      responseConfirmed: item.responseConfirmed === true,
    }));
  if (!models.length) return [];
  try {
    const result = await accountClient.publishSharedModels(models);
    const shared = (Array.isArray(result?.models) ? result.models : [])
      .map((item) => ({
        model: normalizeConcreteModelId(item?.model),
        label: String(item?.label || '').trim().slice(0, 120),
        pickerMode: ['A', 'B'].includes(item?.pickerMode) ? item.pickerMode : null,
        verifiedCount: Math.max(0, Number(item?.verifiedCount || 0)),
        lastSeenAt: item?.lastSeenAt || null,
      }))
      .filter((item) => item.model);
    await chrome.storage.sync.set({ [SHARED_KNOWN_MODELS_KEY]: shared });
    logRuntime('info', 'verification', 'shared_model_catalog_published', { submitted: models.length, shared: shared.length });
    return shared;
  } catch (error) {
    logRuntime('warn', 'verification', 'shared_model_catalog_publish_failed', { submitted: models.length, error: errorText(error) });
    return [];
  }
}

async function discoverAccountCatalog(tabId) {
  try {
    const result = await sendTabMessage(tabId, { type: 'GPTLOCK_DISCOVER_ACCOUNT_MODELS' });
    const rows = Array.isArray(result?.catalog?.models) ? result.catalog.models : [];
    const models = [...new Set(rows
      .map((item) => normalizeConcreteModelId(item?.model || item?.rawId))
      .filter(Boolean))];
    const reasoningLevels = [...new Set((Array.isArray(result?.catalog?.reasoningLevels)
      ? result.catalog.reasoningLevels
      : []).map(normalizeReasoningLevel).filter(Boolean))];
    // Account-menu DOM is discovery input, not authoritative persistence. A model is
    // promoted to discoveredModels by model-catalog.js only after the per-model probe
    // produces trusted network request/response metadata.
    const nameMappings = await resolveUnknownCatalogNames(tabId, rows);
    logRuntime(models.length ? 'info' : 'warn', 'verification', 'account_model_catalog_discovered', {
      tabId,
      models,
      reasoningLevels,
      rowCount: rows.length,
      candidateCount: Number(result?.catalog?.candidateCount || 0),
      triggerFound: result?.catalog?.triggerFound === true,
      pickerKind: result?.catalog?.pickerKind ?? null,
      pickerMode: result?.catalog?.pickerMode ?? null,
      nameMappings,
    });
    const pickerMode = result?.catalog?.pickerMode ?? null;
    return { models, reasoningLevels, rows: rows.map((row) => ({ ...row, pickerMode })), nameMappings, pickerMode };
  } catch (error) {
    logRuntime('warn', 'verification', 'account_model_catalog_discovery_failed', {
      tabId,
      error: errorText(error),
    });
    return { models: [], reasoningLevels: [], rows: [], error: errorText(error) };
  }
}

async function recoverStaleVerificationTurn(tabId, assistantCountBefore) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logRuntime('warn', 'verification', 'verification_stale_generation_reload', { tabId, attempt, maxAttempts: 3 });
    await chrome.tabs.reload(tabId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const settled = await sendTabMessage(tabId, {
      type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
      assistantCountBefore,
      timeoutMs: 3500,
    }).catch(() => null);
    if (settled?.settled === true || settled?.stillGenerating === false) {
      logRuntime('info', 'verification', 'verification_stale_generation_recovered', { tabId, attempt, method: 'reload' });
      return { settled: true, method: 'reload', attempt };
    }
  }
  const stopped = await sendTabMessage(tabId, { type: 'GPTLOCK_STOP_STALE_GENERATION' }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const settled = await sendTabMessage(tabId, {
    type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
    assistantCountBefore,
    timeoutMs: 3500,
  }).catch(() => null);
  const ok = stopped?.stopped === true && (settled?.settled === true || settled?.stillGenerating === false);
  logRuntime(ok ? 'info' : 'warn', 'verification', 'verification_stale_generation_recovered', {
    tabId, method: 'stop-button', stopped: stopped?.stopped === true, settled: Boolean(ok),
  });
  return { settled: Boolean(ok), method: 'stop-button', stopped: stopped?.stopped === true };
}

async function sendVerificationReasoningProbe(tabId, marker, ordinal, total) {
  // Every model gets a different deterministic arithmetic turn. Reusing the same
  // puzzle made all answers identical, which obscured whether the UI had actually
  // advanced to a new model/turn. The result is strictly increasing with ordinal.
  const n = Math.max(1, Number(ordinal) || 1);
  const left = 120 + (n * 7);
  const right = 31 + (n * 5);
  const offset = (n * n) + 17;
  return sendTabMessage(tabId, {
    type: 'GPTLOCK_AUTO_SEND_PROBE',
    skipAlignment: true,
    probeMarker: marker,
    probeText: `${marker} ${ordinal}/${total}：计算 (${left}×${right})+${offset}，只输出“校验值=<整数>”，不要解释、不要复述题目。`,
  });
}

async function verifyAccountCatalogModels(tabId, state, accountCatalog, { restoreModel = null } = {}) {
  // v0.5.95: ChatGPT can expose only a starter catalog in a fresh chat and unlock
  // additional models/reasoning after real turns. Treat discovery as a growing set,
  // not a one-time snapshot. Network metadata remains the sole verification authority.
  const queue = [];
  const knownKeys = new Set();
  const reasoningLevels = new Set();

  const catalogIdentity = ({ model, rawModel, selectorKey, label }) => {
    // A concrete backend model is the stable identity. Picker labels/selectors may
    // change after each real turn (badges, retirement copy, localization), and must
    // never turn one model into a new verification attempt.
    if (model) return `model:${model}`;
    if (rawModel) return `raw:${rawModel}`;
    const selector = String(selectorKey || '').trim().toLowerCase();
    if (selector) return `selector:${selector}`;
    return `label:${String(label || '').trim().toLowerCase()}`;
  };
  const progress = state.autoVerification.catalogVerification = {
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
  };

  const verificationChronology = (item) => {
    const model = normalizeConcreteModelId(item?.model || item?.rawModel);
    // GPT-5.5 is destructive to picker-B availability in current ChatGPT: verify
    // it first while it is still discoverable. All remaining GPT generations are
    // ordered oldest -> newest by their public version lineage; variant name is
    // only a deterministic tie-breaker inside the same generation.
    if (model === 'gpt-5.5') return [-1, 5, 5, ''];
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.*))?$/.exec(model || '');
    if (!match) return [1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, model || item?.label || ''];
    return [0, Number(match[1]), Number(match[2] || 0), String(match[3] || '')];
  };
  const sortVerificationQueue = () => {
    const completed = new Set(progress.results.map((result) => catalogIdentity(result)));
    const pending = queue.filter((item) => !completed.has(catalogIdentity(item)));
    const done = queue.filter((item) => completed.has(catalogIdentity(item)));
    pending.sort((left, right) => {
      const a = verificationChronology(left);
      const b = verificationChronology(right);
      for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
      return String(a[3]).localeCompare(String(b[3]));
    });
    queue.splice(0, queue.length, ...done, ...pending);
  };

  const mergeCatalog = (catalog, phase) => {
    let added = 0;
    if (['A', 'B'].includes(catalog?.pickerMode) && !progress.pickerModes.includes(catalog.pickerMode)) progress.pickerModes.push(catalog.pickerMode);
    for (const level of (catalog?.reasoningLevels || [])) reasoningLevels.add(level);
    for (const row of (Array.isArray(catalog?.rows) ? catalog.rows : [])) {
      const model = normalizeConcreteModelId(row?.model || row?.rawId);
      const rawModel = normalizeConcreteModelId(row?.rawId);
      const selectorKey = String(row?.selectorKey || '').trim().slice(0, 200);
      const label = String(row?.label || model || selectorKey || '').trim().slice(0, 160);
      if (!model && !selectorKey && !label) continue;
      const key = catalogIdentity({ model, rawModel, selectorKey, label });
      if (knownKeys.has(key)) {
        // Refresh the not-yet-run row with the newest picker locator without
        // increasing the terminal workload.
        const existing = queue.find((item) => catalogIdentity(item) === key);
        if (existing && !progress.results.some((result) => catalogIdentity(result) === key)) {
          existing.rawModel = rawModel || existing.rawModel;
          existing.selectorKey = selectorKey || existing.selectorKey;
          existing.label = label || existing.label;
        }
        continue;
      }
      knownKeys.add(key);
      queue.push({ model, rawModel, selectorKey, label, pickerMode: ['A', 'B'].includes(row?.pickerMode) ? row.pickerMode : catalog?.pickerMode || null });
      added += 1;
    }
    sortVerificationQueue();
    progress.total = queue.length;
    progress.reasoningLevels = [...reasoningLevels];
    state.autoVerification.maxAttempts = queue.length;
    logRuntime('info', 'verification', 'account_model_catalog_merged', {
      tabId, phase, added, total: queue.length, reasoningLevels: progress.reasoningLevels,
    });
    return added;
  };

  mergeCatalog(accountCatalog, 'initial');
  await broadcastTabState(tabId);
  logRuntime(queue.length ? 'info' : 'warn', 'verification', 'account_model_verification_started', {
    tabId, total: queue.length, models: queue.map((item) => item.model || item.label),
  });

  let index = 0;
  let stablePasses = 0;
  while (index < queue.length || stablePasses < 2) {
    if (index >= queue.length) {
      const rediscovered = await discoverAccountCatalog(tabId);
      progress.discoveryPasses += 1;
      const added = mergeCatalog(rediscovered, 'settle');
      stablePasses = added ? 0 : stablePasses + 1;
      progress.stablePasses = stablePasses;
      await broadcastTabState(tabId);
      if (index >= queue.length && stablePasses < 2) {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      continue;
    }

    const item = queue[index];
    progress.currentModel = item.model;
    progress.currentSelectorKey = item.selectorKey;
    progress.currentLabel = item.label;
    state.autoVerification.attempt = index + 1;
    const transactionStartedAtMs = Date.now();
    verificationTransactions.set(Number(tabId), {
      model: item.model || null,
      selectorKey: item.selectorKey || '',
      label: item.label || '',
      startedAt: transactionStartedAtMs,
    });
    resetVerificationAttempt(state);
    await broadcastTabState(tabId);
    logRuntime('info', 'verification', 'account_model_verification_model_started', {
      tabId, index: index + 1, total: queue.length, model: item.model, selectorKey: item.selectorKey, label: item.label,
    });

    let abortForPendingTurn = false;
    try {
      const attached = networkMonitor.isAttached(tabId) || await networkMonitor.attach(tabId);
      if (!attached) throw new Error(state.monitor?.error || 'Request lock monitor is not attached');
      const selectionResponse = await sendTabMessage(tabId, {
        type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL',
        model: item.model,
        selectorKey: item.selectorKey,
        label: item.label,
      });
      const selection = selectionResponse?.result || {};
      if (selection.selectionAttempted !== true) throw new Error('Model selection control was not activated');

      const reattached = await networkMonitor.attach(tabId);
      if (!reattached) throw new Error(state.monitor?.error || 'Request lock monitor did not reattach after model selection');
      const probe = await sendVerificationReasoningProbe(tabId, 'GPTWork 模型验证', index + 1, queue.length);
      if (!probe?.sent) throw new Error('Visible model verification probe was not sent');
      const attemptStartedMs = Date.now() - 1500;
      const [waited, turnSettled] = await Promise.all([
        waitForAttemptVerification(tabId, attemptStartedMs),
        sendTabMessage(tabId, {
          type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
          assistantCountBefore: probe.assistantCountBefore ?? 0,
          timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
        }),
      ]);
      let effectiveTurnSettled = turnSettled;
      if (effectiveTurnSettled?.settled !== true) {
        effectiveTurnSettled = await recoverStaleVerificationTurn(tabId, probe.assistantCountBefore ?? 0);
      }
      if (effectiveTurnSettled?.settled !== true) {
        abortForPendingTurn = true;
        throw new Error('ChatGPT response remained non-terminal after 3 reload recoveries and stop-button recovery');
      }
      // The body forwarded at Fetch.requestPaused is the sole request-confirmation
      // authority. Network.requestWillBeSent may expose the page's pre-interception
      // body, so keep it only as diagnostic evidence. Response/stream metadata remains
      // the independent backend-served-model authority.
      const requestId = state.lastRequest?.requestId ?? null;
      const networkObservedRequestModel = normalizeConcreteModelId(state.lastRequest?.model);
      const rewriteCapturedAtMs = Date.parse(state.lastRewrite?.capturedAt || '');
      const authoritativeRewrite = Boolean(
        item.model
        && state.lastRewrite?.authorityKind === 'verification-transaction'
        && state.lastRewrite?.authorityModel === item.model
        && Number.isFinite(rewriteCapturedAtMs)
        && rewriteCapturedAtMs >= transactionStartedAtMs - 250
        && !state.lastRewrite?.error
      );
      const requestModel = item.model
        ? (authoritativeRewrite ? normalizeConcreteModelId(state.lastRewrite?.modelAfter) : null)
        : networkObservedRequestModel;
      const responseEvidence = state.lastResponseEvidence?.requestId === requestId
        ? state.lastResponseEvidence
        : null;
      // Keep the response observation for mismatch/default diagnostics, but never
      // promote it directly to completion proof. The strict verifier may intentionally
      // downgrade this raw candidate.
      const responseObservation = verificationResponseObservation(tabId, responseEvidence);
      const rawResponseModel = normalizeConcreteModelId(responseObservation.model);
      const expectedVerificationRequestId = requestId ? `cdp-${tabId}-${requestId}` : null;
      const terminalVerification = state.lastVerification?.verdict === 'verified'
        && expectedVerificationRequestId
        && state.lastVerification?.requestId === expectedVerificationRequestId
        ? state.lastVerification
        : null;
      const responseModel = normalizeConcreteModelId(terminalVerification?.model);
      const requestConfirmed = item.model
        ? Boolean(authoritativeRewrite) && (
          requestModel === item.model || Boolean(item.rawModel && requestModel === item.rawModel)
        )
        : Boolean(requestModel);
      const responseConfirmed = Boolean(terminalVerification) && (item.model
        ? responseModel === item.model || Boolean(item.rawModel && responseModel === item.rawModel)
        : Boolean(responseModel));
      const requestMismatch = Boolean(item.model && authoritativeRewrite && requestModel) && !requestConfirmed;
      const verified = Boolean(requestId) && requestConfirmed && responseConfirmed && !requestMismatch;
      const evidenceModel = responseModel || (requestConfirmed ? requestModel : null);
      const evidenceSource = responseModel
        ? 'network_response_metadata'
        : requestConfirmed
          ? (item.model ? 'fetch_forwarded_request_metadata' : 'network_request_metadata')
          : null;
      const result = {
        model: item.model || requestModel, rawModel: item.rawModel || requestModel,
        selectorKey: item.selectorKey, label: item.label, verified,
        selected: selection.selectionAttempted === true, requestConfirmed, responseConfirmed,
        requestId, requestModel, networkObservedRequestModel, responseModel, rawResponseModel, evidenceModel,
        responseReasoning: responseEvidence?.reasoning ?? null,
        responseVerdict: responseConfirmed ? 'verified' : state.lastVerification?.verdict ?? null,
        responseIssue: responseConfirmed ? null : state.evidenceIssue ?? null,
        pickerMode: item.pickerMode || null,
        evidenceSource,
        timedOut: waited.timedOut, turnSettled: true, observation: selection.observation || null,
      };
      progress.results.push(result);
      if (requestConfirmed) progress.requestConfirmed += 1;
      if (verified) progress.verified += 1; else progress.failed += 1;
      logRuntime(verified ? 'info' : 'warn', 'verification', 'account_model_verification_model_completed', {
        tabId, index: index + 1, total: queue.length, model: result.model, rawModel: result.rawModel,
        selectorKey: item.selectorKey, label: item.label, verified, requestConfirmed, responseConfirmed,
        requestId: result.requestId, requestModel, networkObservedRequestModel, responseModel, rawResponseModel, evidenceModel: result.evidenceModel,
        responseVerdict: result.responseVerdict, responseIssue: result.responseIssue,
        evidenceSource: result.evidenceSource, timedOut: waited.timedOut,
      });
    } catch (error) {
      progress.failed += 1;
      progress.results.push({ model: item.model, selectorKey: item.selectorKey, label: item.label, pickerMode: item.pickerMode || null, verified: false, error: errorText(error) });
      logRuntime('warn', 'verification', 'account_model_verification_model_failed', {
        tabId, index: index + 1, total: queue.length, model: item.model, selectorKey: item.selectorKey, label: item.label, error: errorText(error),
      });
    }

    verificationTransactions.delete(Number(tabId));
    index += 1;
    progress.completed = index;
    await broadcastTabState(tabId);

    if (abortForPendingTurn) {
      logRuntime('warn', 'verification', 'account_model_verification_aborted_pending_response', { tabId, index, total: queue.length });
      break;
    }

    // GPT-5.5 is verified before Work is enabled because picker A exposes it
    // directly. From this point on, enable GPTWork's tab-scoped Work feature in the
    // verification runtime itself. Do not click GPTWork UI and do not send a fake
    // bootstrap chat turn: subsequent discovery must run under the same Work feature
    // state that the user would enable from GPTWork.
    if (item.model === 'gpt-5.5') {
      try {
        const featureState = await enableWorkModeForVerification(tabId);
        logRuntime('info', 'verification', 'verification_work_mode_transition', {
          tabId,
          phase: 'post_gpt_5_5',
          entered: featureState?.workModeEnabled === true,
          source: 'verification_runtime_default',
        });
      } catch (error) {
        logRuntime('warn', 'verification', 'verification_work_mode_transition', {
          tabId,
          phase: 'post_gpt_5_5',
          entered: false,
          source: 'verification_runtime_default',
          error: errorText(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }

    // A completed real turn / Work transition may unlock account models/capabilities.
    let rediscovered = await discoverAccountCatalog(tabId);
    progress.discoveryPasses += 1;
    // GPT-5.6 Sol can be the capability-unlock turn for picker B. If the normal
    // verification turn did not expose B, run one additional reasoning-heavy Sol
    // turn, wait for a terminal response with the same recovery contract, then
    // rediscover before moving to the next model.
    if (item.model === 'gpt-5.6-sol' && rediscovered?.pickerMode !== 'B') {
      logRuntime('info', 'verification', 'verification_sol_picker_b_unlock_started', { tabId, pickerMode: rediscovered?.pickerMode ?? null });
      const unlockProbe = await sendVerificationReasoningProbe(tabId, 'GPTWork GPT-5.6 Sol 能力解锁验证', index, queue.length);
      if (unlockProbe?.sent) {
        let unlockSettled = await sendTabMessage(tabId, {
          type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
          assistantCountBefore: unlockProbe.assistantCountBefore ?? 0,
          timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
        });
        if (unlockSettled?.settled !== true) {
          unlockSettled = await recoverStaleVerificationTurn(tabId, unlockProbe.assistantCountBefore ?? 0);
        }
        if (unlockSettled?.settled === true) {
          rediscovered = await discoverAccountCatalog(tabId);
          progress.discoveryPasses += 1;
          logRuntime('info', 'verification', 'verification_sol_picker_b_unlock_completed', { tabId, pickerMode: rediscovered?.pickerMode ?? null });
        }
      }
    }
    const added = mergeCatalog(rediscovered, 'post-turn');
    stablePasses = added ? 0 : stablePasses + 1;
    progress.stablePasses = stablePasses;
    await broadcastTabState(tabId);
  }

  verificationTransactions.delete(Number(tabId));
  progress.currentModel = null;
  progress.currentSelectorKey = null;
  progress.currentLabel = null;
  if (restoreModel && queue.some((item) => item.model === restoreModel)) {
    try { await sendTabMessage(tabId, { type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL', model: restoreModel, label: restoreModel }); }
    catch (error) {
      logRuntime('warn', 'verification', 'account_model_verification_restore_failed', { tabId, model: restoreModel, error: errorText(error) });
    }
  }
  logRuntime(progress.failed ? 'warn' : 'info', 'verification', 'account_model_verification_completed', {
    tabId, total: progress.total, uniqueModels: knownKeys.size, requestConfirmed: progress.requestConfirmed,
    verified: progress.verified, failed: progress.failed,
    discoveryPasses: progress.discoveryPasses, stablePasses: progress.stablePasses,
    reasoningLevels: progress.reasoningLevels, results: progress.results,
  });
  await broadcastTabState(tabId);
  return progress;
}

function modelVerificationHistoryRecord(tabId, autoVerification) {
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
    schemaVersion: 1,
    type: 'gptwork-model-verification-report',
    generatedAt: record.completedAt || new Date().toISOString(),
    verification: { ...record },
  };
  return record;
}

async function persistModelVerificationHistory(tabId, autoVerification) {
  const stored = await chrome.storage.local.get([
    MODEL_VERIFICATION_HISTORY_KEY,
    MODEL_VERIFICATION_HISTORY_ENABLED_KEY,
  ]);
  if (stored[MODEL_VERIFICATION_HISTORY_ENABLED_KEY] !== true) return null;
  const record = modelVerificationHistoryRecord(tabId, autoVerification);
  const previous = Array.isArray(stored[MODEL_VERIFICATION_HISTORY_KEY])
    ? stored[MODEL_VERIFICATION_HISTORY_KEY]
    : [];
  const next = [record, ...previous.filter((item) => item?.id !== record.id)]
    .slice(0, MODEL_VERIFICATION_HISTORY_LIMIT);
  await chrome.storage.local.set({ [MODEL_VERIFICATION_HISTORY_KEY]: next });
  return record;
}

async function autoVerify(tabId) {
  if (!masterRuntimeEnabled()) throw new Error('GPTWork is disabled / GPTWork 已关闭');
  const tab = await chrome.tabs.get(tabId);
  if (!isChatGptUrl(tab.url ?? '')) throw new Error('Open chatgpt.com first / 请先打开 chatgpt.com');
  const state = ensureTabState(tabId, tab.url);
  const startedAt = new Date().toISOString();
  const pageContext = /^https:\/\/chatgpt\.com\/c\/[^/?#]+/i.test(tab.url || '') ? 'existing_chat' : 'new_chat';
  logRuntime('info', 'verification', 'auto_verify_started', { tabId, pageContext });

  const coreCheck = await refreshNativeCore({ tolerateFailure: true });
  const monitorAttached = await networkMonitor.attach(tabId);
  const responseCaptureEnabled = monitorAttached
    ? await networkMonitor.enableResponseCapture(tabId).catch(() => false)
    : false;
  logRuntime(responseCaptureEnabled ? 'info' : 'warn', 'network', 'verification_response_capture', {
    tabId,
    enabled: responseCaptureEnabled,
    attachedTabs: networkMonitor.attachedCount(),
    responseCaptureTabs: networkMonitor.responseCaptureCount(),
  });
  const page = await collectPageObservation(tabId, state);
  const restoreModel = normalizeConcreteModelId(state.pageObservation?.model);

  // Verification owns its visible lifecycle from the moment the transaction starts.
  // Catalog discovery is a phase of that same transaction, not a prerequisite hidden
  // from the progress UI.
  state.autoVerification = {
    running: true,
    startedAt,
    completedAt: null,
    pageContext,
    attempt: 0,
    maxAttempts: 0,
    retries: 0,
    outcome: 'running',
    reason: null,
    requestLockConfirmed: false,
    requestModel: null,
    responseModel: null,
    responseReasoning: null,
    evidenceSource: null,
    attempts: [],
    catalogVerification: null,
  };
  try {
    await startAutoVerificationStreamCapture(tabId, startedAt);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_start_failed', { tabId, error: errorText(error) });
  }
  resetVerificationAttempt(state);
  state.lastError = page.error;
  await broadcastTabState(tabId);

  const sharedKnownModels = await syncSharedKnownModels();
  state.autoVerification.sharedKnownModelCount = sharedKnownModels.length;
  // Do not enter Work before GPT-5.5. Current ChatGPT changes the model-picker
  // topology when Work is enabled; field evidence shows GPT-5.5 must be verified
  // first in Chat mode, then Work is enabled inside verifyAccountCatalogModels()
  // before rediscovering picker B and continuing with later models.
  const accountCatalog = await discoverAccountCatalog(tabId);
  state.autoVerification.workDiscovery = { attempted: false, entered: false, reason: 'deferred_until_after_gpt_5_5' };
  state.autoVerification.maxAttempts = accountCatalog.rows.length;
  await broadcastTabState(tabId);

  if (!monitorAttached) {
    logRuntime('warn', 'verification', 'auto_verify_request_lock_unavailable', {
      tabId,
      monitorError: state.monitor?.error ?? null,
    });
  }

  const catalogVerification = await verifyAccountCatalogModels(
    tabId,
    state,
    accountCatalog,
    { restoreModel },
  );
  await publishVerifiedModels(catalogVerification);
  state.autoVerification.attempts = catalogVerification.results.map((item, index) => ({
    attempt: index + 1,
    sent: Boolean(item.requestId),
    requestLockConfirmed: item.requestConfirmed === true,
    requestModel: item.requestModel ?? null,
    responseModel: item.responseModel ?? null,
    responseConfirmed: item.responseConfirmed === true,
    evidenceModel: item.evidenceModel ?? null,
    responseReasoning: item.responseReasoning ?? null,
    responseIssue: item.responseIssue ?? null,
    evidenceSource: item.evidenceSource ?? null,
    verdict: item.responseVerdict ?? null,
    outcome: item.verified ? 'verified' : 'unverified',
    reason: item.verified ? null : item.error || 'model_verification_incomplete',
  }));

  const successful = catalogVerification.results.filter((item) => item.verified);
  const requestConfirmedResults = catalogVerification.results.filter((item) => item.requestConfirmed);
  const lastResult = catalogVerification.results.at(-1) ?? null;
  const lastVerified = successful.at(-1) ?? null;
  const lastRequestConfirmed = requestConfirmedResults.at(-1) ?? null;
  const finalOutcome = catalogVerification.total === 0
    ? 'unverified'
    : catalogVerification.failed === 0 && catalogVerification.verified === catalogVerification.total
      ? 'verified'
      : catalogVerification.verified > 0
        ? 'partial'
        : 'unverified';
  const finalReason = catalogVerification.total === 0
    ? 'account_model_catalog_empty'
    : catalogVerification.failed
      ? catalogVerification.requestConfirmed === catalogVerification.total
        ? 'response_model_evidence_incomplete'
        : 'account_model_verification_incomplete'
      : null;

  state.autoVerification.running = false;
  state.autoVerification.completedAt = new Date().toISOString();
  state.autoVerification.outcome = finalOutcome;
  state.autoVerification.reason = finalReason;
  state.autoVerification.retries = 0;
  state.autoVerification.requestLockConfirmed = catalogVerification.total > 0
    && catalogVerification.requestConfirmed === catalogVerification.total;
  state.autoVerification.requestModel = lastResult?.requestModel ?? lastRequestConfirmed?.requestModel ?? null;
  state.autoVerification.responseModel = lastVerified?.responseModel ?? null;
  state.autoVerification.responseReasoning = lastVerified?.responseReasoning ?? null;
  state.autoVerification.evidenceSource = lastVerified
    ? 'network_response_metadata'
    : lastRequestConfirmed
      ? 'network_request_metadata'
      : null;
  try {
    await finalizeAutoVerificationStreamCapture(tabId, state.autoVerification.completedAt);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_finalize_failed', { tabId, error: errorText(error) });
  }
  try {
    await persistModelVerificationHistory(tabId, state.autoVerification);
  } catch (error) {
    logRuntime('warn', 'verification', 'model_verification_history_write_failed', { tabId, error: errorText(error) });
  }
  await networkMonitor.disableResponseCapture(tabId);
  await broadcastTabState(tabId);

  logRuntime(finalOutcome === 'verified' ? 'info' : 'warn', 'verification', 'auto_verify_completed', {
    tabId,
    outcome: finalOutcome,
    reason: finalReason,
    catalogTotal: catalogVerification.total,
    catalogRequestConfirmed: catalogVerification.requestConfirmed,
    catalogVerified: catalogVerification.verified,
    catalogFailed: catalogVerification.failed,
    models: catalogVerification.results.map((item) => ({
      model: item.model,
      verified: item.verified,
      requestConfirmed: item.requestConfirmed === true,
      responseConfirmed: item.responseConfirmed === true,
      requestModel: item.requestModel ?? null,
      networkObservedRequestModel: item.networkObservedRequestModel ?? null,
      responseModel: item.responseModel ?? null,
      evidenceModel: item.evidenceModel ?? null,
      evidenceSource: item.evidenceSource ?? null,
    })),
  });

  return {
    ready: catalogVerification.total > 0,
    sent: catalogVerification.results.some((item) => Boolean(item.requestId)),
    outcome: finalOutcome,
    reason: finalReason,
    attempts: catalogVerification.total,
    retries: 0,
    requestLockConfirmed: state.autoVerification.requestLockConfirmed,
    requestModel: state.autoVerification.requestModel,
    responseModel: state.autoVerification.responseModel,
    responseReasoning: state.autoVerification.responseReasoning,
    evidenceSource: state.autoVerification.evidenceSource,
    catalogTotal: catalogVerification.total,
    catalogRequestConfirmed: catalogVerification.requestConfirmed,
    catalogVerified: catalogVerification.verified,
    catalogFailed: catalogVerification.failed,
    checks: {
      coreConnected: coreCheck.connected,
      coreError: coreCheck.error,
      monitorAttached,
      pageCollected: page.collected,
      pageCollectionError: page.error,
      pageModel: restoreModel,
      pageReasoning: state.pageObservation?.reasoning ?? null,
      discoveredModels: accountCatalog.models,
      discoveredReasoningLevels: accountCatalog.reasoningLevels,
    },
    autoVerification: state.autoVerification,
    tabState: publicTabState(state),
  };
}

function diagnosticTabState(state) {
  return {
    tabId: state.tabId,
    inScope: isChatGptUrl(state.url),
    contextKey: state.contextKey,
    core: state.core,
    monitor: state.monitor,
    phase: state.phase,
    probeUsed: state.probeUsed,
    probeArmed: state.probeArmed,
    pageObservation: state.pageObservation,
    lastRewrite: state.lastRewrite,
    lastRequest: state.lastRequest ? {
      capturedAt: state.lastRequest.capturedAt,
      model: state.lastRequest.model,
      reasoning: state.lastRequest.reasoning,
      diagnostics: state.lastRequest.diagnostics,
    } : null,
    lastVerification: state.lastVerification,
    lastResponseEvidence: state.lastResponseEvidence,
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
    updatedAt: state.updatedAt,
    guard: guardFor(state),
  };
}

function diagnosticExportLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300;
  return Math.min(300, Math.max(1, Math.trunc(parsed)));
}

async function createDiagnosticBundle({ entryLimit = 300 } = {}) {
  const limit = diagnosticExportLimit(entryLimit);
  const [stored, allRuntimeLogs, platform] = await Promise.all([
    chrome.storage.local.get(['nativeStatus', DIAGNOSTIC_SSE_STORAGE_KEY]),
    getRuntimeLogs(),
    getPlatformInfo(),
  ]);
  const runtimeLogs = allRuntimeLogs.slice(-limit);
  let nativeDiagnostics = null;
  let nativeDiagnosticsError = null;
  try {
    nativeDiagnostics = await sendNative('get_diagnostics', { auditLimit: limit });
  } catch (error) {
    nativeDiagnosticsError = errorText(error);
  }
  const rawStreamCapture = stored[DIAGNOSTIC_SSE_STORAGE_KEY] ?? null;
  const safeBundle = sanitizeLogValue({
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    exportSelection: {
      recentEntries: limit,
      runtimeLogCount: runtimeLogs.length,
    },
    extension: {
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      platform,
      userAgent: navigator.userAgent,
    },
    policy: currentPolicy,
    settings: currentSettings,
    nativeStatus: stored.nativeStatus ?? { connected: false },
    tabs: [...tabStates.values()].map(diagnosticTabState),
    runtimeLogs,
    nativeDiagnostics,
    nativeDiagnosticsError,
  });
  return {
    ...safeBundle,
    privacy: {
      chatContentIncluded: Boolean(rawStreamCapture?.entries?.length),
      autoVerificationStreamIncluded: Boolean(rawStreamCapture?.entries?.length),
      autoVerificationSseIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => entry.transport === 'sse')),
      autoVerificationWebSocketIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => entry.transport === 'websocket')),
      autoVerificationOnly: true,
      accountCredentialsIncluded: false,
      requestHeadersIncluded: false,
      responseHeadersIncluded: false,
      streamResumeTokensMayBeIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => typeof entry.rawSse === 'string' && entry.rawSse.includes('resume_conversation_token'))),
      noteZhCn: '普通聊天仍不打包请求/响应正文。仅自动验证固定测试消息对应的初始 SSE、handoff 后续 SSE 与已匹配 topic 的服务端 WebSocket 接收帧进入诊断包，合计上限 10 MiB。原始 handoff SSE 可能包含短期 resume token、消息/会话 ID 和服务器元数据；不采集 Cookie、Authorization、请求头、响应头或浏览器账号凭据。',
      noteEn: 'Ordinary chat bodies remain excluded. Only the fixed auto-verification probes may contribute initial SSE, post-handoff SSE, and server-to-client WebSocket frames matched to the handoff topic, with one 10 MiB aggregate cap. Raw handoff SSE can contain short-lived resume tokens, message/conversation IDs, and server metadata; cookies, Authorization, request/response headers, and browser account credentials are not captured.',
    },
    autoVerificationStream: rawStreamCapture,
  };
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    void masterStorageEnabled().then((enabled) => {
      if (enabled) return initialize();
      return chrome.alarms.clear(RECONNECT_ALARM);
    });
  }
  if (alarm.name === ACCOUNT_REFRESH_ALARM) {
    void masterStorageEnabled().then((enabled) => {
      if (enabled) return refreshAccountHeartbeat();
      return chrome.alarms.clear(ACCOUNT_REFRESH_ALARM);
    });
  }
  if (alarm.name === RUNTIME_LOG_UPLOAD_ALARM) {
    void syncRuntimeLogsToNative().catch(() => {});
  }
});

// Keep native window lifecycle listeners registered at all times, but do not turn a
// Master-OFF state into account heartbeats or debugger sweeps.
chrome.windows.onCreated.addListener(() => {
  if (masterRuntimeEnabled()) void refreshAccountHeartbeat();
});
chrome.windows.onRemoved.addListener(() => {
  if (masterRuntimeEnabled()) void refreshAccountHeartbeat();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isChatGptUrl(changeInfo.url)) {
    tabStates.delete(tabId);
    if (networkMonitor.isAttached(tabId)) void networkMonitor.detach(tabId);
    return;
  }
  if (isChatGptUrl(tab.url ?? '') && (changeInfo.url || changeInfo.status === 'complete')) {
    void configureTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  if (networkMonitor.isAttached(tabId)) void networkMonitor.detach(tabId);
});

function applyConfigurationChange({ policyChanged = false, settingsChanged = false, localEnabledChanged = false } = {}) {
  if (policyChanged && masterRuntimeEnabled()) {
    void syncPolicy().catch(async (error) => {
      await writeNativeStatus({ connected: false, lastError: errorText(error) });
    });
  }
  if (!policyChanged && !settingsChanged && !localEnabledChanged) return;
  logRuntime('info', 'settings', 'configuration_changed', {
    policyChanged,
    settingsChanged,
    localEnabledChanged,
    enabled: currentSettings.enabled,
    responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    strictMode: currentPolicy.strictMode,
  });
  for (const state of tabStates.values()) {
    state.phase = 'initial';
    state.probeUsed = false;
    state.probeArmed = false;
    state.lastRewrite = null;
    state.lastVerification = null;
    state.lastEvidenceDiagnostics = null;
    state.streamTracking = null;
    state.evidenceIssue = null;
    state.lastError = null;
    state.autoVerification = null;
    if (masterRuntimeEnabled()) void broadcastTabState(state.tabId);
  }
  if (localEnabledChanged) {
    if (masterRuntimeEnabled()) void initializeAfterCurrentTask();
    else void stopBackgroundRuntime('master_disabled');
    return;
  }
  void configureOpenTabs();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[LOCAL_ENABLED_KEY]) {
    const next = typeof changes[LOCAL_ENABLED_KEY].newValue === 'boolean'
      ? changes[LOCAL_ENABLED_KEY].newValue
      : currentSettings.enabled;
    const changed = Boolean(currentSettings.enabled) !== next;
    localEnabledOverride = next;
    currentSettings = normalizeSettings({ ...currentSettings, enabled: next });
    if (changed) applyConfigurationChange({ localEnabledChanged: true });
    return;
  }
  if (areaName !== 'sync') return;
  const policyChanged = Boolean(changes.policy);
  const settingsChanged = Boolean(changes.settings);
  if (policyChanged) currentPolicy = normalizePolicy(changes.policy.newValue);
  if (settingsChanged) {
    const syncedSettings = normalizeSettings(changes.settings.newValue);
    currentSettings = normalizeSettings({
      ...syncedSettings,
      enabled: typeof localEnabledOverride === 'boolean' ? localEnabledOverride : syncedSettings.enabled,
    });
  }
  applyConfigurationChange({ policyChanged, settingsChanged });
});

const TAB_FEATURE_MESSAGE_TYPES = new Set([
  'GPTWORK_TAB_FEATURE_GET',
  'GPTWORK_TAB_FEATURE_SET',
  'GPTWORK_MASTER_STATUS',
  'GPTWORK_MASTER_SET',
]);

// These messages are owned by background-update.js. The generic router must return
// false so exactly one listener responds; otherwise Settings can receive the generic
// "Unsupported extension message" error before the updater listener answers.
const UPDATE_MESSAGE_TYPES = new Set([
  'GPTWORK_UPDATE_STATUS_GET',
  'GPTWORK_UPDATE_CHECK',
  'GPTWORK_UPDATE_INSTALL',
  'GPTWORK_CORE_REPAIR',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GPTWORK_SET_JANK_ISOLATION') {
    void applyJankIsolationMode(message.mode, {
      source: message.source || 'message',
      label: message.label || null,
      captureId: message.captureId || null,
    }).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: errorText(error) }),
    );
    return true;
  }
  if (message?.type === 'GPTWORK_GET_JANK_ISOLATION') {
    void chrome.storage.local.get(JANK_ISOLATION_KEY).then((stored) => {
      sendResponse({ ok: true, result: stored[JANK_ISOLATION_KEY] || { mode: 'normal' } });
    });
    return true;
  }
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  if (TAB_FEATURE_MESSAGE_TYPES.has(message.type) || UPDATE_MESSAGE_TYPES.has(message.type)) return false;

  const run = async () => {
    switch (message.type) {
      case 'GPTLOCK_GET_STATE': {
        const tabId = Number.isInteger(message.tabId)
          ? message.tabId
          : sender.tab?.id ?? await activeTabId();
        const { nativeStatus } = await chrome.storage.local.get('nativeStatus');
        const state = tabId === null ? null : tabStates.get(tabId);
        if (masterRuntimeEnabled() && tabId !== null && state && isChatGptUrl(state.url)) {
          await collectPageObservation(tabId, state);
        }
        return {
          policy: state ? runtimePolicyForTabSync(state.tabId) : currentPolicy,
          settings: state ? effectiveSettingsForState(state) : currentSettings,
          nativeStatus: nativeStatus ?? { connected: false },
          tabState: state ? publicTabState(state) : null,
          extensionVersion: chrome.runtime.getManifest().version,
          account: accountState,
          accountWindowAllowed: state ? accountAllowsState(state) : false,
        };
      }
      case 'GPTLOCK_ACCOUNT_CONFIG':
        return accountClient.config();
      case 'GPTLOCK_ACCOUNT_REGISTER':
        return accountClient.register(message.email, message.password);
      case 'GPTLOCK_ACCOUNT_RESEND_VERIFICATION':
        return accountClient.resendVerification(message.email);
      case 'GPTLOCK_ACCOUNT_VERIFY_EMAIL':
        return accountClient.verifyEmail(message.email, message.code);
      case 'GPTLOCK_ACCOUNT_LOGIN': {
        accountState = await accountClient.login(message.email, message.password, message.replaceDeviceRecordIds);
        await refreshAccountHeartbeat();
        return accountState;
      }
      case 'GPTLOCK_ACCOUNT_FORGOT_PASSWORD':
        return accountClient.requestPasswordReset(message.email);
      case 'GPTLOCK_ACCOUNT_RESET_PASSWORD': {
        const result = await accountClient.resetPassword(message.email, message.code, message.newPassword);
        accountState = accountClient.snapshot();
        await configureOpenTabs();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_LOGOUT': {
        accountState = await accountClient.logout();
        await configureOpenTabs();
        return accountState;
      }
      case 'GPTLOCK_ACCOUNT_REFRESH':
        return refreshAccountHeartbeat();
      case 'GPTLOCK_ACCOUNT_SECURITY':
        return accountClient.security();
      case 'GPTLOCK_ACCOUNT_RELEASE_DEVICE': {
        const result = await accountClient.releaseDevice(message.deviceRecordId);
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_REVOKE_SESSION': {
        const result = await accountClient.revokeSession(message.sessionId);
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_REVOKE_OTHER_SESSIONS': {
        const result = await accountClient.revokeOtherSessions();
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_CHANGE_PASSWORD':
        return accountClient.changePassword(message.currentPassword, message.newPassword);
      case 'GPTLOCK_ACCOUNT_CREATE_ORDER':
        return accountClient.createOrder(message.planCode, message.paymentMethod);
      case 'GPTLOCK_ACCOUNT_GET_ORDER':
        return accountClient.getOrder(message.orderId);
      case 'GPTLOCK_RECONNECT': {
        if (!await masterStorageEnabled()) return { skipped: true, reason: 'master_disabled' };
        const previousPort = nativePort;
        nativePort = null;
        rejectPending(new Error('Native host reconnect requested'));
        previousPort?.disconnect();
        await initializeAfterCurrentTask();
        logRuntime('info', 'native', 'manual_reconnect_completed');
        return { ok: true };
      }
      case 'GPTLOCK_POINTER_TRACE': {
        if (!sender.tab?.id) throw new Error('Pointer trace requires a tab');
        logRuntime('info', 'ui-pointer', String(message.event || 'trace').slice(0, 80), {
          tabId: sender.tab.id,
          url: sender.tab.url || null,
          ...(message.details && typeof message.details === 'object' ? message.details : {}),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_TRUSTED_POINTER_PREPARE': {
        if (!sender.tab?.id) throw new Error('Trusted pointer preparation requires a tab');
        const attached = networkMonitor.isAttached(sender.tab.id) || await networkMonitor.attach(sender.tab.id);
        if (!attached) throw new Error('Debugger is not attached for trusted pointer input');
        return { attached: true };
      }
      case 'GPTLOCK_TRUSTED_POINTER': {
        if (!sender.tab?.id) throw new Error('Trusted pointer input requires a tab');
        const x = Number(message.x);
        const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
          throw new Error('Trusted pointer coordinates are invalid');
        }
        const action = message.action === 'move' ? 'move' : 'click';
        logRuntime('info', 'ui-pointer', 'cdp_dispatch', {
          tabId: sender.tab.id,
          traceId: message.traceId ?? null,
          source: String(message.source || 'unspecified').slice(0, 100),
          action, x, y,
          target: message.target ?? null,
          hit: message.hit ?? null,
        });
        await networkMonitor.trustedPointer(sender.tab.id, { action, x, y });
        return { action, x, y };
      }
      case 'GPTLOCK_PAGE_OBSERVATION': {
        if (!sender.tab?.id) throw new Error('Page observation requires a tab');
        const state = ensureTabState(sender.tab.id, sender.tab.url);
        const previous = state.pageObservation;
        state.pageObservation = {
          model: message.observation?.model ?? null,
          reasoning: message.observation?.reasoning ?? null,
          capturedAt: message.observation?.capturedAt ?? new Date().toISOString(),
          evidenceSource: 'page_dom',
          modelEvidenceSource: message.observation?.modelEvidenceSource ?? 'none',
          reasoningEvidenceSource: message.observation?.reasoningEvidenceSource ?? 'none',
          modelLabel: message.observation?.modelLabel ?? '',
          reasoningLabel: message.observation?.reasoningLabel ?? '',
          ambiguousModel: Boolean(message.observation?.ambiguousModel),
          candidates: Array.isArray(message.observation?.candidates) ? message.observation.candidates.slice(0, 8) : [],
        };
        if (
          previous?.model && state.pageObservation.model
          && previous.model !== state.pageObservation.model
        ) {
          state.phase = 'initial';
          state.lastVerification = null;
          state.lastEvidenceDiagnostics = null;
          state.streamTracking = null;
          state.evidenceIssue = null;
          logRuntime('info', 'page', 'selection_changed', {
            tabId: sender.tab.id,
            previousModel: previous.model,
            previousReasoning: previous.reasoning,
            model: state.pageObservation.model,
            reasoning: state.pageObservation.reasoning,
          });
        }
        await broadcastTabState(sender.tab.id);
        return publicTabState(state);
      }
      case 'GPTLOCK_CONTEXT_BUDGET_DIAGNOSTIC': {
        if (!sender.tab?.id) throw new Error('Context budget diagnostic requires a tab');
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        const numberOrZero = (value) => {
          const number = Number(value);
          return Number.isFinite(number) && number > 0 ? number : 0;
        };
        logRuntime('info', 'context-budget', 'remaining_snapshot', {
          tabId: sender.tab.id,
          conversationHash: String(details.conversationHash || 'ctx-unknown').slice(0, 32),
          model: String(details.model || '').slice(0, 128) || null,
          remainingPercent: Math.min(100, Math.max(0, Number(details.remainingPercent) || 0)),
          remainingDisplay: String(details.remainingDisplay || '').slice(0, 16),
          remainingSource: String(details.remainingSource || 'unknown').slice(0, 80),
          measurementSource: String(details.measurementSource || 'unknown').slice(0, 80),
          historyTokens: numberOrZero(details.historyTokens),
          historyCharacters: numberOrZero(details.historyCharacters),
          historyMessages: numberOrZero(details.historyMessages),
          cumulativeTokens: numberOrZero(details.cumulativeTokens),
          cumulativeCharacters: numberOrZero(details.cumulativeCharacters),
          cumulativeMessages: numberOrZero(details.cumulativeMessages),
          checkpointMatched: details.checkpointMatched === true,
          checkpointRestored: details.checkpointRestored === true,
          hardLimitObservedCount: Math.max(0, Math.floor(Number(details.hardLimitObservedCount) || 0)),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_PERFORMANCE_DIAGNOSTIC': {
        if (!sender.tab?.id) throw new Error('Performance diagnostic requires a tab');
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        logRuntime(details.abnormal === true ? 'warn' : 'info', 'performance', 'page_responsiveness_sample', {
          tabId: sender.tab.id,
          url: sender.tab.url || null,
          eventLoopLagMs: Math.max(0, Math.min(60000, Number(details.eventLoopLagMs) || 0)),
          maxLongTaskMs: Math.max(0, Math.min(60000, Number(details.maxLongTaskMs) || 0)),
          longTaskCount: Math.max(0, Math.min(10000, Number(details.longTaskCount) || 0)),
          recentLongTasks: sanitizeLogValue(Array.isArray(details.recentLongTasks) ? details.recentLongTasks.slice(-8) : []),
          mutationCount: Math.max(0, Math.min(1000000, Number(details.mutationCount) || 0)),
          mutationCallbacks: Math.max(0, Math.min(100000, Number(details.mutationCallbacks) || 0)),
          maxMutationCallbackMs: Math.max(0, Math.min(60000, Number(details.maxMutationCallbackMs) || 0)),
          verificationRunning: details.verificationRunning === true,
          documentVisibility: String(details.documentVisibility || '').slice(0, 32),
          abnormal: details.abnormal === true,
          runtimeLifecycle: sanitizeLogValue(details.runtimeLifecycle || null),
          cdp: networkMonitor.diagnosticsSnapshot({ reset: true }),
          debuggerAttachedTabs: networkMonitor.attachedCount(),
          responseCaptureTabs: networkMonitor.responseCaptureCount(),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_CONTEXT_CHANGED': {
        if (!sender.tab?.id) throw new Error('Context update requires a tab');
        const state = ensureTabState(sender.tab.id, message.url || sender.tab.url);
        await broadcastTabState(sender.tab.id);
        return publicTabState(state);
      }
      case 'GPTLOCK_SEND_STARTED': {
        if (!sender.tab?.id) throw new Error('Send event requires a tab');
        const state = ensureTabState(sender.tab.id, sender.tab.url);
        const verification = verificationTransactionForTab(sender.tab.id);
        const guard = guardFor(state);
        if (!verification && !guard.canSend) {
          logRuntime('warn', 'guard', 'send_rejected', {
            tabId: sender.tab.id,
            status: guard.status,
            reason: guard.reason,
          });
          return { accepted: false, guard };
        }
        if (guard.allowKind === 'disabled' || guard.allowKind === 'outside_scope') {
          return { accepted: true, guard };
        }
        if (currentSettings.networkVerificationEnabled) state.phase = 'waiting';
        state.probeUsed = true;
        state.probeArmed = false;
        state.lastError = null;
        state.evidenceIssue = null;
        logRuntime('info', 'guard', 'send_accepted', {
          tabId: sender.tab.id,
          allowKind: guard.allowKind,
          status: guard.status,
        });
        await broadcastTabState(sender.tab.id);
        return { accepted: true, guard: guardFor(state) };
      }
      case 'GPTLOCK_ARM_PROBE': {
        const tabId = Number.isInteger(message.tabId) ? message.tabId : await activeTabId();
        if (tabId === null) throw new Error('No active tab');
        const state = ensureTabState(tabId);
        state.phase = 'initial';
        state.probeArmed = false;
        state.lastVerification = null;
        state.streamTracking = null;
        state.lastError = null;
        state.evidenceIssue = null;
        state.autoVerification = null;
        logRuntime('info', 'verification', 'legacy_probe_reset', { tabId });
        await broadcastTabState(tabId);
        return publicTabState(state);
      }
      case 'GPTLOCK_AUTO_VERIFY': {
        const tabId = await chatGptTabId(Number.isInteger(message.tabId) ? message.tabId : null);
        if (tabId === null) throw new Error('No ChatGPT tab / 没有打开的 ChatGPT 标签页');
        const state = tabStates.get(tabId);
        if (!state || !accountAllowsState(state)) throw new Error('当前账号没有有效权益');
        return autoVerify(tabId);
      }
      case 'GPTLOCK_SEND_BLOCKED': {
        logRuntime('warn', 'guard', 'send_blocked_in_page', {
          tabId: sender.tab?.id ?? null,
          status: message.status ?? null,
          reason: message.reason ?? null,
        });
        return { recorded: true };
      }
      case 'GPTLOCK_VERIFY': {
        const policy = sender.tab?.id
          ? runtimePolicyForTabSync(sender.tab.id)
          : currentPolicy;
        return verifyObservation(message.observation ?? {}, policy);
      }
      case 'GPTLOCK_GET_RUNTIME_LOGS':
        return { logs: await getRuntimeLogs() };
      case 'GPTLOCK_CLEAR_RUNTIME_LOGS':
        await Promise.all([clearRuntimeLogs(), clearAutoVerificationStreamCapture()]);
        logRuntime('info', 'diagnostics', 'runtime_logs_cleared');
        return { cleared: true };
      case 'GPTLOCK_EXPORT_DIAGNOSTICS': {
        const bundle = await createDiagnosticBundle({ entryLimit: message.entryLimit });
        logRuntime('info', 'diagnostics', 'bundle_created', {
          runtimeLogCount: bundle.runtimeLogs?.length ?? 0,
          nativeAuditCount: bundle.nativeDiagnostics?.auditRecords?.length ?? 0,
          nativeDiagnosticsError: bundle.nativeDiagnosticsError,
          rawStreamEntryCount: bundle.autoVerificationStream?.entries?.length ?? 0,
          rawStreamIncludedBytes: bundle.autoVerificationStream?.includedBytes ?? 0,
          rawStreamOverflowed: Boolean(bundle.autoVerificationStream?.overflowed),
        });
        return bundle;
      }
      case 'GPTLOCK_OPEN_DIAGNOSTICS':
        await chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
        return { ok: true };
      case 'GPTLOCK_OPEN_OPTIONS':
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        throw new Error(`Unsupported extension message: ${message.type}`);
    }
  };

  run().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
      status: error?.status || null,
      details: error?.details && typeof error.details === 'object' ? error.details : null,
    }),
  );
  return true;
});

void initialize();