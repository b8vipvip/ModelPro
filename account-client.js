import {
  clearCapabilityLease,
  setCapabilityLease,
  setCapabilityLeaseIdentity,
} from './capability-lease-client.js';

const API_BASE = 'https://gptlock.mv3.cn';
const SESSION_KEY = 'gptlockAccountSessionToken';
const DEVICE_KEY = 'gptlockAccountDeviceId';
const BROWSER_KEY = 'gptlockAccountBrowserInstanceId';
const SNAPSHOT_KEY = 'gptlockAccountSnapshot';

function randomId(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${value}`;
}

function platformInfo() {
  return new Promise((resolve) => chrome.runtime.getPlatformInfo((info) => resolve(info || {})));
}

function normalizeAccount(account, extra = {}) {
  if (!account?.authenticated) {
    return {
      authenticated: false,
      authorized: false,
      allowedWindowKeys: [],
      deniedWindowKeys: [],
      lastError: extra.lastError || null,
    };
  }
  return {
    ...account,
    authenticated: true,
    authorized: Boolean(account.entitlement?.active),
    allowedWindowKeys: Array.isArray(extra.allowedWindowKeys) ? extra.allowedWindowKeys : [],
    deniedWindowKeys: Array.isArray(extra.deniedWindowKeys) ? extra.deniedWindowKeys : [],
    lastError: extra.lastError || null,
  };
}

export function createAccountClient({ baseUrl = API_BASE } = {}) {
  let token = '';
  let deviceId = '';
  let browserInstanceId = '';
  let state = normalizeAccount(null);
  let sessionHydrated = false;
  let hydratePromise = null;
  let initializePromise = null;
  let initialized = false;

  async function ensureIds() {
    if (sessionHydrated && deviceId && browserInstanceId) {
      setCapabilityLeaseIdentity({ deviceId, browserInstanceId, extensionId: chrome.runtime.id });
      return { deviceId, browserInstanceId };
    }
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      const stored = await chrome.storage.local.get([DEVICE_KEY, BROWSER_KEY, SESSION_KEY, SNAPSHOT_KEY]);
      deviceId = deviceId || (typeof stored[DEVICE_KEY] === 'string' && stored[DEVICE_KEY] ? stored[DEVICE_KEY] : randomId('device'));
      browserInstanceId = browserInstanceId || (typeof stored[BROWSER_KEY] === 'string' && stored[BROWSER_KEY] ? stored[BROWSER_KEY] : randomId('browser'));
      // Session hydration is one-shot for this background generation. A stale storage.get
      // that started before login must never overwrite a newer in-memory token/snapshot.
      if (!sessionHydrated) {
        token = typeof stored[SESSION_KEY] === 'string' ? stored[SESSION_KEY] : '';
        state = normalizeAccount(stored[SNAPSHOT_KEY]);
        sessionHydrated = true;
      }
      await chrome.storage.local.set({ [DEVICE_KEY]: deviceId, [BROWSER_KEY]: browserInstanceId });
      setCapabilityLeaseIdentity({ deviceId, browserInstanceId, extensionId: chrome.runtime.id });
      return { deviceId, browserInstanceId };
    })().finally(() => {
      hydratePromise = null;
    });
    return hydratePromise;
  }

  async function persist(next) {
    state = normalizeAccount(next, {
      allowedWindowKeys: next?.allowedWindowKeys || state.allowedWindowKeys,
      deniedWindowKeys: next?.deniedWindowKeys || state.deniedWindowKeys,
      lastError: next?.lastError || null,
    });
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: state });
    return state;
  }

  async function request(path, { method = 'GET', body, auth = false } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth && token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      if (auth && response.status === 401) await clearSession();
      const error = new Error(data.error?.message || `HTTP ${response.status}`);
      error.code = data.error?.code || `HTTP_${response.status}`;
      error.status = response.status;
      error.details = data.error?.details && typeof data.error.details === 'object' ? data.error.details : null;
      throw error;
    }
    return data;
  }

  async function clientIdentity(extra = {}) {
    await ensureIds();
    const platform = await platformInfo();
    return {
      deviceId,
      browserInstanceId,
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      platform: [platform.os, platform.arch].filter(Boolean).join('/') || navigator.platform || 'unknown',
      ...extra,
    };
  }

  async function initialize() {
    if (initialized) return state;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      await ensureIds();
      if (!token) {
        clearCapabilityLease();
        return persist(null);
      }
      try {
        return await me();
      } catch (error) {
        // A transient transport/server failure must not turn a still-valid local session
        // into an apparent logout. Only an explicit 401 clears the token/session inside
        // request()/me(). Keep the last authenticated snapshot and annotate the refresh
        // failure so the next heartbeat can recover without flashing the login UI.
        state = { ...state, lastError: error.message };
        await chrome.storage.local.set({ [SNAPSHOT_KEY]: state });
        return state;
      }
    })();
    try {
      const result = await initializePromise;
      initialized = true;
      return result;
    } finally {
      initializePromise = null;
    }
  }

  async function clearSession() {
    token = '';
    state = normalizeAccount(null);
    sessionHydrated = true;
    initialized = true;
    clearCapabilityLease();
    await chrome.storage.local.remove([SESSION_KEY, SNAPSHOT_KEY]);
    return state;
  }

  async function config() {
    const data = await request('/api/v1/account/config');
    return data;
  }

  async function register(email, password) {
    const identity = await clientIdentity({ email, password });
    return request('/api/v1/auth/register', { method: 'POST', body: identity });
  }

  async function resendVerification(email) {
    const identity = await clientIdentity({ email });
    return request('/api/v1/auth/resend-verification', { method: 'POST', body: identity });
  }

  async function verifyEmail(email, code) {
    const identity = await clientIdentity({ email, code });
    return request('/api/v1/auth/verify-email', { method: 'POST', body: identity });
  }

  async function login(email, password, replaceDeviceRecordIds = []) {
    // Login is serialized behind the one-time session hydration. This prevents an
    // in-flight startup initialize()/me() from later clearing or overwriting a newly
    // issued session token after an extension update/service-worker restart.
    await initialize();
    const identity = await clientIdentity({ email, password, replaceDeviceRecordIds });
    const data = await request('/api/v1/auth/login', { method: 'POST', body: identity });
    token = String(data.sessionToken || '');
    if (!token) throw new Error('登录响应缺少会话令牌');
    clearCapabilityLease();
    sessionHydrated = true;
    initialized = true;
    await chrome.storage.local.set({ [SESSION_KEY]: token });
    return persist(data.account);
  }

  async function logout() {
    await initialize();
    try { if (token) await request('/api/v1/account/logout', { method: 'POST', body: {}, auth: true }); }
    catch {}
    return clearSession();
  }

  async function requestPasswordReset(email) {
    const identity = await clientIdentity({ email });
    return request('/api/v1/auth/forgot-password', { method: 'POST', body: identity });
  }

  async function resetPassword(email, code, newPassword) {
    const identity = await clientIdentity({ email, code, newPassword });
    const data = await request('/api/v1/auth/reset-password', { method: 'POST', body: identity });
    await clearSession();
    return data;
  }

  async function me() {
    await ensureIds();
    if (!token) {
      clearCapabilityLease();
      return persist(null);
    }
    try {
      const data = await request('/api/v1/account/me', { auth: true });
      return persist(data.account);
    } catch (error) {
      if (error.status === 401) return persist(null);
      throw error;
    }
  }

  async function heartbeat(windowKeys = []) {
    await initialize();
    if (!token) {
      clearCapabilityLease();
      return persist(null);
    }
    const identity = await clientIdentity({ windowKeys });
    try {
      const data = await request('/api/v1/account/heartbeat', { method: 'POST', body: identity, auth: true });
      setCapabilityLease(data.capabilityLease);
      return persist({
        ...data.account,
        allowedWindowKeys: data.allowedWindowKeys || [],
        deniedWindowKeys: data.deniedWindowKeys || [],
      });
    } catch (error) {
      if (error.status === 401) return persist(null);
      state = { ...state, lastError: error.message };
      await chrome.storage.local.set({ [SNAPSHOT_KEY]: state });
      throw error;
    }
  }

  async function clientControl() {
    await initialize();
    if (!token) return null;
    return request('/api/v1/client/control', { auth: true });
  }

  async function security() {
    await initialize();
    return request('/api/v1/account/security', { auth: true });
  }

  async function sharedModelCatalog() {
    await initialize();
    if (!token) return { ok: true, models: [] };
    return request('/api/v1/account/model-catalog', { auth: true });
  }

  async function publishSharedModels(models) {
    await initialize();
    if (!token) return { ok: true, accepted: 0, models: [] };
    return request('/api/v1/account/model-catalog', {
      method: 'POST',
      body: { models: Array.isArray(models) ? models : [] },
      auth: true,
    });
  }

  async function releaseDevice(deviceRecordId) {
    await initialize();
    return request('/api/v1/account/devices/release', { method: 'POST', body: { deviceRecordId }, auth: true });
  }

  async function revokeSession(sessionId) {
    await initialize();
    return request('/api/v1/account/sessions/revoke', { method: 'POST', body: { sessionId }, auth: true });
  }

  async function revokeOtherSessions() {
    await initialize();
    return request('/api/v1/account/sessions/revoke-others', { method: 'POST', body: {}, auth: true });
  }

  async function changePassword(currentPassword, newPassword) {
    await initialize();
    const data = await request('/api/v1/account/change-password', {
      method: 'POST', body: { currentPassword, newPassword }, auth: true,
    });
    return data;
  }

  async function createOrder(planCode, paymentMethod) {
    await initialize();
    return request('/api/v1/account/orders', {
      method: 'POST', body: { planCode, paymentMethod }, auth: true,
    });
  }

  async function getOrder(orderId) {
    await initialize();
    return request(`/api/v1/account/orders/${encodeURIComponent(orderId)}`, { auth: true });
  }

  function snapshot() { return state; }
  function hasSession() { return Boolean(token); }

  return {
    initialize,
    config,
    register,
    resendVerification,
    verifyEmail,
    login,
    logout,
    requestPasswordReset,
    resetPassword,
    me,
    heartbeat,
    clientControl,
    security,
    sharedModelCatalog,
    publishSharedModels,
    releaseDevice,
    revokeSession,
    revokeOtherSessions,
    changePassword,
    createOrder,
    getOrder,
    snapshot,
    hasSession,
    clearSession,
  };
}
