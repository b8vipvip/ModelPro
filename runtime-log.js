export const RUNTIME_LOG_STORAGE_KEY = 'runtimeLogs';
export const MAX_RUNTIME_LOG_ENTRIES = 2000;
export const RUNTIME_LOG_UPLOADED_IDS_KEY = 'runtimeLogUploadedIds';
export const RUNTIME_LOG_NATIVE_IDS_KEY = 'runtimeLogNativeIds';
export const RUNTIME_LOG_UPLOAD_ALARM = 'gptlock-runtime-log-upload';
export const RUNTIME_LOG_UPLOAD_BATCH_SIZE = 50;
export const RUNTIME_LOG_SYNC_KEY = 'gptworkRuntimeLogSyncEnabled';

const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 300;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const MAX_UPLOAD_DETAILS_CHARS = 12000;
const API_BASE = 'https://gptlock.mv3.cn';
const SESSION_KEY = 'gptlockAccountSessionToken';
const DEVICE_KEY = 'gptlockAccountDeviceId';
const BROWSER_KEY = 'gptlockAccountBrowserInstanceId';
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|prompt|postdata|requestbody|responsebody|chat(?:text|content)|message(?:text|content)|answer(?:text|content)|inputtext|outputtext)$/i;

export const MAX_DIAGNOSTIC_SSE_BYTES = 10 * 1024 * 1024;
export const MAX_DIAGNOSTIC_STREAM_BYTES = MAX_DIAGNOSTIC_SSE_BYTES;

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}

export function createDiagnosticSseCapture({ tabId = null, startedAt = null } = {}) {
  return {
    schemaVersion: 2,
    captureScope: 'auto_verification_stream_only',
    maxBytes: MAX_DIAGNOSTIC_STREAM_BYTES,
    tabId,
    startedAt: startedAt || new Date().toISOString(),
    completedAt: null,
    totalBytes: 0,
    includedBytes: 0,
    overflowed: false,
    omittedResponses: 0,
    omittedBytes: 0,
    entries: [],
    omitted: [],
  };
}

export function appendDiagnosticSseCapture(capture, entry, maxBytes = MAX_DIAGNOSTIC_STREAM_BYTES) {
  const base = capture && typeof capture === 'object' ? capture : createDiagnosticSseCapture();
  const next = {
    ...base,
    schemaVersion: 2,
    captureScope: 'auto_verification_stream_only',
    maxBytes,
    totalBytes: Number(base.totalBytes || 0),
    includedBytes: Number(base.includedBytes || 0),
    overflowed: Boolean(base.overflowed),
    omittedResponses: Number(base.omittedResponses || 0),
    omittedBytes: Number(base.omittedBytes || 0),
    entries: Array.isArray(base.entries) ? [...base.entries] : [],
    omitted: Array.isArray(base.omitted) ? [...base.omitted] : [],
  };
  const rawData = typeof entry?.rawData === 'string'
    ? entry.rawData
    : typeof entry?.rawSse === 'string'
      ? entry.rawSse
      : typeof entry?.rawFrame === 'string'
        ? entry.rawFrame
        : '';
  const bodyBytes = utf8ByteLength(rawData);
  next.totalBytes += bodyBytes;
  if (!rawData || bodyBytes === 0) return next;

  const projected = next.includedBytes + bodyBytes;
  if (projected > maxBytes) {
    next.overflowed = true;
    next.omittedResponses += 1;
    next.omittedBytes += bodyBytes;
    next.omitted.push({
      attempt: entry?.attempt ?? null,
      requestId: entry?.requestId ?? null,
      capturedAt: entry?.capturedAt ?? null,
      endpoint: entry?.endpoint ?? null,
      httpStatus: entry?.httpStatus ?? null,
      mimeType: entry?.mimeType ?? null,
      bodyFormat: entry?.bodyFormat ?? null,
      transport: entry?.transport ?? null,
      direction: entry?.direction ?? null,
      stage: entry?.stage ?? null,
      bodyBytes,
      reason: 'diagnostic_stream_size_limit',
    });
    return next;
  }

  const transport = entry?.transport || (/event-stream/i.test(entry?.mimeType || '') ? 'sse' : 'unknown');
  const stored = {
    attempt: entry?.attempt ?? null,
    requestId: entry?.requestId ?? null,
    capturedAt: entry?.capturedAt ?? null,
    endpoint: entry?.endpoint ?? null,
    httpStatus: entry?.httpStatus ?? null,
    mimeType: entry?.mimeType ?? null,
    bodyFormat: entry?.bodyFormat ?? null,
    transport,
    direction: entry?.direction ?? 'received',
    stage: entry?.stage ?? null,
    requestModel: entry?.requestModel ?? null,
    rewriteReason: entry?.rewriteReason ?? null,
    streamContext: entry?.streamContext ?? null,
    bodyBytes,
  };
  if (transport === 'websocket') stored.rawFrame = rawData;
  else stored.rawSse = rawData;
  next.entries.push(stored);
  next.includedBytes = projected;
  return next;
}

export function finalizeDiagnosticSseCapture(capture, completedAt = null) {
  if (!capture || typeof capture !== 'object') return null;
  return { ...capture, completedAt: completedAt || new Date().toISOString() };
}

let writeQueue = Promise.resolve();
let uploadQueue = Promise.resolve();
let pendingLogEntries = [];
let pendingLogWaiters = [];
let logWriteTimer = null;
const LOG_WRITE_COALESCE_MS = 250;
const LOG_WRITE_MAX_BATCH = 25;
const RUNTIME_LOG_SESSION_ID = `runtime:${Date.now()}:${Math.random().toString(16).slice(2)}`;
let runtimeLogSequence = 0;

function clipString(value) {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated:${value.length}]`;
}

function randomLogId() {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `log:${value}`;
}

export function sanitizeLogValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return clipString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return clipString(String(value));
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const omitted = Math.max(0, value.length - MAX_ARRAY_ITEMS);
    const result = value
      .slice(-MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, depth + 1, seen));
    if (omitted > 0) result.unshift(`[truncated:${value.length};omitted:${omitted};kept:last]`);
    return result;
  }

  const result = {};
  const entries = Object.entries(value);
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitizeLogValue(child, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) result._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
  return result;
}

export function boundRuntimeLogs(entries, limit = MAX_RUNTIME_LOG_ENTRIES) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(-Math.max(1, limit));
}

export function shouldPersistRuntimeLog(level, component, event, details = {}) {
  const normalizedLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
  const normalizedComponent = String(component || 'extension');
  const normalizedEvent = String(event || 'unknown');

  // A non-official/private request can be observed several times per second on every
  // ChatGPT tab. It is not a lock failure and carries no formal request correlation id.
  // Apply this before the level gate so historical copies that were accidentally
  // persisted as info/warn are compacted out when the log is read or appended.
  if (
    normalizedComponent === 'lock'
    && normalizedEvent === 'request_lock_checked'
    && details?.changed !== true
    && !details?.error
    && !details?.requestId
    && details?.reason === 'private_request_not_official'
  ) return false;

  // Warnings/errors are diagnostic evidence unless they are a known browser-only
  // rendering warning with no bearing on the request/Core chain.
  if (normalizedLevel === 'warn' || normalizedLevel === 'error') {
    if (
      normalizedComponent === 'content-runtime'
      && normalizedEvent === 'uncaught_error'
      && /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i.test(String(details?.message || ''))
    ) return false;
    return true;
  }

  // Context-budget snapshots are operational telemetry, not request/core diagnostics.
  // Retain only snapshots close to exhaustion or carrying a hard-limit observation.
  if (normalizedComponent === 'context-budget' && normalizedEvent === 'remaining_snapshot') {
    const remaining = Number(details?.remainingPercent);
    const hardLimitObserved = Number(details?.hardLimitObservedCount || 0) > 0;
    return hardLimitObserved || (Number.isFinite(remaining) && remaining <= 10);
  }

  return true;
}

export function filterRuntimeLogs(entries) {
  return boundRuntimeLogs(entries).filter((entry) => shouldPersistRuntimeLog(
    entry?.level,
    entry?.component,
    entry?.event,
    entry?.details,
  ));
}

function createEntry(level, component, event, details) {
  runtimeLogSequence += 1;
  return {
    sessionId: RUNTIME_LOG_SESSION_ID,
    sequence: runtimeLogSequence,
    id: randomLogId(),
    timestamp: new Date().toISOString(),
    level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    component: clipString(String(component || 'extension')),
    event: clipString(String(event || 'unknown')),
    details: sanitizeLogValue(details ?? {}),
  };
}

export function prepareRuntimeLogUploadEntry(entry) {
  const safe = {
    id: typeof entry?.id === 'string' && entry.id ? entry.id : randomLogId(),
    timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
    level: ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'info',
    component: clipString(String(entry?.component || 'extension')),
    event: clipString(String(entry?.event || 'unknown')),
    details: sanitizeLogValue(entry?.details ?? {}),
  };
  const rawDetails = JSON.stringify(safe.details);
  if (rawDetails.length > MAX_UPLOAD_DETAILS_CHARS) {
    safe.details = {
      _truncatedForUpload: true,
      originalChars: rawDetails.length,
      preview: rawDetails.slice(0, MAX_UPLOAD_DETAILS_CHARS),
    };
  }
  return safe;
}

function flushPendingRuntimeLogs() {
  if (logWriteTimer !== null) {
    clearTimeout(logWriteTimer);
    logWriteTimer = null;
  }
  if (!pendingLogEntries.length) return writeQueue;
  const entries = pendingLogEntries;
  const waiters = pendingLogWaiters;
  pendingLogEntries = [];
  pendingLogWaiters = [];
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(RUNTIME_LOG_STORAGE_KEY);
      const logs = boundRuntimeLogs([
        ...filterRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]),
        ...entries,
      ].sort((left, right) => {
        const timeDelta = Date.parse(left?.timestamp || 0) - Date.parse(right?.timestamp || 0);
        if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
        if (left?.sessionId && left.sessionId === right?.sessionId) {
          return Number(left?.sequence || 0) - Number(right?.sequence || 0);
        }
        return 0;
      }));
      await chrome.storage.local.set({ [RUNTIME_LOG_STORAGE_KEY]: logs });
    });
  writeQueue.then(
    () => waiters.forEach(({ resolve }, index) => resolve(entries[index] || null)),
    (error) => waiters.forEach(({ reject }) => reject(error)),
  );
  return writeQueue;
}

export function appendRuntimeLog(level, component, event, details = {}) {
  if (!shouldPersistRuntimeLog(level, component, event, details)) return Promise.resolve(null);
  const entry = createEntry(level, component, event, details);
  const completion = new Promise((resolve, reject) => {
    pendingLogEntries.push(entry);
    pendingLogWaiters.push({ resolve, reject });
  });
  const critical = level === 'error'
    || component === 'verification'
    || /(?:completed|failed|aborted|terminal|recovery)/i.test(String(event || ''));
  if (critical || pendingLogEntries.length >= LOG_WRITE_MAX_BATCH) {
    void flushPendingRuntimeLogs();
  } else if (logWriteTimer === null) {
    logWriteTimer = setTimeout(() => void flushPendingRuntimeLogs(), LOG_WRITE_COALESCE_MS);
  }
  return completion;
}

export async function getRuntimeLogs() {
  await flushPendingRuntimeLogs().catch(() => {});
  const stored = await chrome.storage.local.get(RUNTIME_LOG_STORAGE_KEY);
  const raw = boundRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]);
  const logs = filterRuntimeLogs(raw).sort((left, right) => {
    const timeDelta = Date.parse(left?.timestamp || 0) - Date.parse(right?.timestamp || 0);
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
    if (left?.sessionId && left.sessionId === right?.sessionId) {
      return Number(left?.sequence || 0) - Number(right?.sequence || 0);
    }
    return 0;
  });
  if (logs.length !== raw.length || logs.some((entry, index) => entry !== raw[index])) {
    await chrome.storage.local.set({ [RUNTIME_LOG_STORAGE_KEY]: logs });
  }
  return logs;
}

export async function runtimeLogNativeBatch(limit = RUNTIME_LOG_UPLOAD_BATCH_SIZE) {
  await flushPendingRuntimeLogs().catch(() => {});
  const stored = await chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY, RUNTIME_LOG_NATIVE_IDS_KEY]);
  const logs = filterRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]);
  const persisted = new Set(Array.isArray(stored[RUNTIME_LOG_NATIVE_IDS_KEY]) ? stored[RUNTIME_LOG_NATIVE_IDS_KEY] : []);
  return logs.filter((entry) => entry?.id && !persisted.has(entry.id)).slice(0, Math.max(1, limit));
}

export async function markRuntimeLogsNative(ids) {
  const acknowledged = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  if (!acknowledged.size) return;
  const stored = await chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY, RUNTIME_LOG_NATIVE_IDS_KEY]);
  const logs = boundRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]);
  const liveIds = new Set(logs.map((entry) => entry?.id).filter(Boolean));
  const persisted = new Set(Array.isArray(stored[RUNTIME_LOG_NATIVE_IDS_KEY]) ? stored[RUNTIME_LOG_NATIVE_IDS_KEY] : []);
  for (const id of acknowledged) if (liveIds.has(id)) persisted.add(id);
  await chrome.storage.local.set({
    [RUNTIME_LOG_NATIVE_IDS_KEY]: [...persisted].filter((id) => liveIds.has(id)).slice(-MAX_RUNTIME_LOG_ENTRIES),
  });
}

async function runtimeLogUploadBatch(limit = RUNTIME_LOG_UPLOAD_BATCH_SIZE) {
  await flushPendingRuntimeLogs().catch(() => {});
  const stored = await chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY, RUNTIME_LOG_UPLOADED_IDS_KEY]);
  let logs = filterRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]);
  let changed = false;
  logs = logs.map((entry) => {
    if (typeof entry?.id === 'string' && entry.id) return entry;
    changed = true;
    return { ...entry, id: randomLogId() };
  });
  if (changed) await chrome.storage.local.set({ [RUNTIME_LOG_STORAGE_KEY]: logs });
  const uploaded = new Set(Array.isArray(stored[RUNTIME_LOG_UPLOADED_IDS_KEY]) ? stored[RUNTIME_LOG_UPLOADED_IDS_KEY] : []);
  return logs.filter((entry) => !uploaded.has(entry.id)).slice(0, Math.max(1, limit));
}

async function markRuntimeLogsUploaded(ids) {
  const acknowledged = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id));
  if (!acknowledged.size) return;
  const stored = await chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY, RUNTIME_LOG_UPLOADED_IDS_KEY]);
  const logs = boundRuntimeLogs(stored[RUNTIME_LOG_STORAGE_KEY]);
  const liveIds = new Set(logs.map((entry) => entry?.id).filter(Boolean));
  const uploaded = new Set(Array.isArray(stored[RUNTIME_LOG_UPLOADED_IDS_KEY]) ? stored[RUNTIME_LOG_UPLOADED_IDS_KEY] : []);
  for (const id of acknowledged) if (liveIds.has(id)) uploaded.add(id);
  await chrome.storage.local.set({
    [RUNTIME_LOG_UPLOADED_IDS_KEY]: [...uploaded].filter((id) => liveIds.has(id)).slice(-MAX_RUNTIME_LOG_ENTRIES),
  });
}

export async function uploadRuntimeLogBatch() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.runtime?.getManifest) {
    return { uploaded: 0, skipped: 'runtime_unavailable' };
  }
  uploadQueue = uploadQueue.catch(() => {}).then(async () => {
    const identity = await chrome.storage.local.get([SESSION_KEY, DEVICE_KEY, BROWSER_KEY, RUNTIME_LOG_SYNC_KEY]);
    if (identity[RUNTIME_LOG_SYNC_KEY] !== true) return { uploaded: 0, skipped: 'sync_disabled' };
    const token = typeof identity[SESSION_KEY] === 'string' ? identity[SESSION_KEY] : '';
    if (!token) return { uploaded: 0, skipped: 'no_account_session' };
    const pending = await runtimeLogUploadBatch();
    if (!pending.length) return { uploaded: 0, skipped: 'nothing_pending' };

    const response = await fetch(`${API_BASE}/api/v1/account/runtime-logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceId: identity[DEVICE_KEY] || '',
        browserInstanceId: identity[BROWSER_KEY] || '',
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        logs: pending.map(prepareRuntimeLogUploadEntry),
      }),
      cache: 'no-store',
      credentials: 'omit',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error?.message || `Runtime log upload failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const acknowledgedIds = Array.isArray(data.acknowledgedIds)
      ? data.acknowledgedIds
      : pending.map((entry) => entry.id);
    await markRuntimeLogsUploaded(acknowledgedIds);
    return {
      uploaded: acknowledgedIds.length,
      accepted: Number(data.accepted || 0),
      duplicates: Number(data.duplicates || 0),
    };
  });
  return uploadQueue;
}

export async function clearRuntimeLogs() {
  await flushPendingRuntimeLogs().catch(() => {});
  await chrome.storage.local.set({
    [RUNTIME_LOG_STORAGE_KEY]: [],
    [RUNTIME_LOG_UPLOADED_IDS_KEY]: [],
    [RUNTIME_LOG_NATIVE_IDS_KEY]: [],
  });
}

function installRuntimeLogUploader() {
  if (typeof chrome === 'undefined' || !chrome.alarms?.create || !chrome.alarms?.onAlarm) return;
  try {
    chrome.alarms.create(RUNTIME_LOG_UPLOAD_ALARM, { delayInMinutes: 0.2, periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name === RUNTIME_LOG_UPLOAD_ALARM) void uploadRuntimeLogBatch().catch(() => {});
    });
    void uploadRuntimeLogBatch().catch(() => {});
  } catch {
    // Logging must never make the extension fail to start.
  }
}

installRuntimeLogUploader();
