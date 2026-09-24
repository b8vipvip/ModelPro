import { normalizeConcreteModelId, normalizePolicy } from './policy.js';
import { appendRuntimeLog } from './runtime-log.js';
import { scheduleAccountRefresh } from './account-refresh-scheduler.js';

export const TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV2';
export const LEGACY_TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV1';
export const WINDOW_FEATURE_SESSION_KEY = 'gptworkWindowFeatureStatesV1';
export const TAB_FEATURE_MIGRATION_KEY = 'gptworkTabFeatureMigrationV1';
export const LEGACY_WORK_MODE_KEY = 'gptworkWorkModeEnabled';
export const LEGACY_MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
export const MASTER_KEY = 'gptworkEnabledLocal';
export const WINDOW_QUOTA_MESSAGE = '当前账户并发窗口超限';

const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
const DISCOVERED_MODELS_KEY = 'discoveredModels';
const ACCOUNT_SNAPSHOT_KEY = 'gptlockAccountSnapshot';
const BASE_WORK_MODELS = Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']);
const DEFAULT_TAB_FEATURE_STATE = Object.freeze({
  workModeEnabled: true,
  modelLockEnabled: true,
});
const FEATURE_MESSAGE_TYPES = new Set([
  'GPTWORK_TAB_FEATURE_GET',
  'GPTWORK_TAB_FEATURE_SET',
  'GPTWORK_MASTER_STATUS',
  'GPTWORK_MASTER_SET',
]);

// Work/Model state is owned by the concrete ChatGPT tab. It is intentionally not
// inherited from windowId: two ChatGPT tabs in the same Chrome window must be able to
// hold different states. windowId is used only for account concurrency authorization.
const states = new Map();
const tabWindowIds = new Map();
let basePolicy = normalizePolicy(null);
let modelLockSelection = [];
let discoveredModels = [];
let masterEnabled = false;
let initialized = false;
let initializePromise = null;
let selectionWriteInFlight = false;

function log(event, details = {}, level = 'info') {
  void appendRuntimeLog(level, 'tab-feature', event, details).catch(() => {});
}

function normalizeState(value) {
  return {
    workModeEnabled: value?.workModeEnabled === true,
    modelLockEnabled: value?.modelLockEnabled === true,
  };
}

function normalizeModels(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeConcreteModelId)
    .filter(Boolean))];
}

function sameModels(left, right) {
  return JSON.stringify(normalizeModels(left)) === JSON.stringify(normalizeModels(right));
}

function isAtLeastSol(model) {
  const normalized = normalizeConcreteModelId(model);
  if (!normalized) return false;
  if (normalized === 'gpt-6-astra' || normalized === 'gpt-5.6-sol') return true;
  const match = normalized.match(/^gpt-(\d+)(?:[.-](\d+))?/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function workModels() {
  return [...new Set([
    ...BASE_WORK_MODELS,
    ...normalizeModels(discoveredModels).filter(isAtLeastSol),
  ])];
}

function rememberTabWindow(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return null;
  tabWindowIds.set(tab.id, tab.windowId);
  return tab.windowId;
}

export async function resolveWindowIdForTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const cached = tabWindowIds.get(id);
  if (Number.isInteger(cached)) return cached;
  try {
    const tab = await chrome.tabs.get(id);
    return rememberTabWindow(tab);
  } catch {
    return null;
  }
}

function serializedStates() {
  return Object.fromEntries([...states.entries()].map(([tabId, value]) => [String(tabId), normalizeState(value)]));
}

async function persistStates() {
  await chrome.storage.session.set({ [TAB_FEATURE_SESSION_KEY]: serializedStates() });
}

function openTabIds(tabs) {
  return new Set(tabs
    .map((tab) => Number(tab?.id))
    .filter(Number.isInteger));
}

async function migrateLegacySession(sessionStored, tabs) {
  const liveTabIds = openTabIds(tabs);
  const currentMap = sessionStored[TAB_FEATURE_SESSION_KEY];
  if (currentMap && typeof currentMap === 'object') {
    for (const [key, value] of Object.entries(currentMap)) {
      const tabId = Number(key);
      if (liveTabIds.has(tabId)) states.set(tabId, normalizeState(value));
    }
  }

  const legacyTabMap = sessionStored[LEGACY_TAB_FEATURE_SESSION_KEY];
  if (legacyTabMap && typeof legacyTabMap === 'object') {
    for (const [key, value] of Object.entries(legacyTabMap)) {
      const tabId = Number(key);
      if (liveTabIds.has(tabId) && !states.has(tabId)) states.set(tabId, normalizeState(value));
    }
  }

  // The temporary window-scoped implementation was not the intended product model.
  // When upgrading from it, copy the window value into each currently open tab once;
  // from that point forward every tab owns its state independently.
  const legacyWindowMap = sessionStored[WINDOW_FEATURE_SESSION_KEY];
  if (legacyWindowMap && typeof legacyWindowMap === 'object') {
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId) || states.has(tab.id)) continue;
      const value = legacyWindowMap[String(tab.windowId)];
      if (value && typeof value === 'object') states.set(tab.id, normalizeState(value));
    }
  }

  await persistStates();
  try {
    await chrome.storage.session.remove([LEGACY_TAB_FEATURE_SESSION_KEY, WINDOW_FEATURE_SESSION_KEY]);
  } catch {}
  log('legacy_feature_scope_migrated_to_tabs', {
    tabCount: states.size,
    hadLegacyTabState: Boolean(legacyTabMap && typeof legacyTabMap === 'object'),
    hadLegacyWindowState: Boolean(legacyWindowMap && typeof legacyWindowMap === 'object'),
  });
}

async function migrateLegacyFlags(storedLocal, tabs) {
  if (storedLocal[TAB_FEATURE_MIGRATION_KEY] === true) return;
  const legacy = normalizeState({
    workModeEnabled: storedLocal[LEGACY_WORK_MODE_KEY] === true,
    modelLockEnabled: storedLocal[LEGACY_MODEL_LOCK_KEY] === true,
  });
  if (legacy.workModeEnabled || legacy.modelLockEnabled) {
    for (const tab of tabs) {
      if (Number.isInteger(tab?.id) && !states.has(tab.id)) states.set(tab.id, legacy);
    }
    await persistStates();
  }
  await chrome.storage.local.set({
    [TAB_FEATURE_MIGRATION_KEY]: true,
    [LEGACY_WORK_MODE_KEY]: false,
    [LEGACY_MODEL_LOCK_KEY]: false,
  });
  log('legacy_feature_flags_migrated', {
    workModeEnabled: legacy.workModeEnabled,
    modelLockEnabled: legacy.modelLockEnabled,
    migratedTabCount: states.size,
  });
}

async function restoreExplicitModelSelectionForMigration(storedLocal) {
  if (storedLocal[TAB_FEATURE_MIGRATION_KEY] === true || !modelLockSelection.length) return;
  if (sameModels(basePolicy.lockedModels, modelLockSelection)) return;
  basePolicy = normalizePolicy({ ...basePolicy, lockedModels: modelLockSelection });
  selectionWriteInFlight = true;
  try {
    await chrome.storage.sync.set({ policy: basePolicy });
    log('legacy_model_selection_restored', { lockedModels: modelLockSelection });
  } finally {
    selectionWriteInFlight = false;
  }
}

export async function initializeTabFeatureRuntime() {
  if (initialized) return;
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    const [sessionStored, localStored, syncStored, tabs] = await Promise.all([
      chrome.storage.session.get([
        TAB_FEATURE_SESSION_KEY,
        LEGACY_TAB_FEATURE_SESSION_KEY,
        WINDOW_FEATURE_SESSION_KEY,
      ]),
      chrome.storage.local.get([
        TAB_FEATURE_MIGRATION_KEY,
        LEGACY_WORK_MODE_KEY,
        LEGACY_MODEL_LOCK_KEY,
        MASTER_KEY,
      ]),
      chrome.storage.sync.get(['policy', MODEL_SELECTION_KEY, DISCOVERED_MODELS_KEY]),
      chrome.tabs.query({ url: 'https://chatgpt.com/*' }),
    ]);

    for (const tab of tabs) rememberTabWindow(tab);
    await migrateLegacySession(sessionStored, tabs);
    basePolicy = normalizePolicy(syncStored.policy);
    modelLockSelection = normalizeModels(syncStored[MODEL_SELECTION_KEY]);
    discoveredModels = normalizeModels(syncStored[DISCOVERED_MODELS_KEY]);
    masterEnabled = localStored[MASTER_KEY] === true;
    await restoreExplicitModelSelectionForMigration(localStored);
    await migrateLegacyFlags(localStored, tabs);
    initialized = true;
  })().finally(() => {
    initializePromise = null;
  });
  return initializePromise;
}

export function tabFeatureStateSync(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return normalizeState(null);
  return normalizeState(states.has(id) ? states.get(id) : DEFAULT_TAB_FEATURE_STATE);
}

export async function getTabFeatureState(tabId) {
  await initializeTabFeatureRuntime();
  return tabFeatureStateSync(tabId);
}

// Model verification uses the same tab-scoped Work feature state as the product UI.
// This is a direct runtime state transition; it does not click GPTWork UI controls or
// synthesize a ChatGPT message. Once GPT-5.5 is finished, verification enables Work
// here so the subsequent catalog discovery runs under the real Work feature contract.
export async function enableWorkModeForVerification(tabId) {
  const featureState = await setTabFeatureState(tabId, { workModeEnabled: true });
  await pushFeatureState(Number(tabId), featureState);
  log('verification_work_mode_enabled', { tabId: Number(tabId), workModeEnabled: true });
  return featureState;
}

export function tabFeatureEnabledSync(tabId) {
  if (!masterEnabled) return false;
  const state = tabFeatureStateSync(tabId);
  return state.workModeEnabled || state.modelLockEnabled;
}

export function effectivePolicyForTabSync(tabId) {
  const feature = masterEnabled ? tabFeatureStateSync(tabId) : normalizeState(null);
  const active = [];
  if (feature.workModeEnabled) active.push(...workModels());
  if (feature.modelLockEnabled) {
    active.push(...(modelLockSelection.length ? modelLockSelection : normalizeModels(basePolicy.lockedModels)));
  }
  return normalizePolicy({
    ...basePolicy,
    lockedModels: active.length ? [...new Set(active)] : basePolicy.lockedModels,
  });
}

export function lockConfigurationForTabSync(tabId, fallback = {}) {
  const policy = effectivePolicyForTabSync(tabId);
  return {
    ...fallback,
    lockedModels: policy.lockedModels,
    allowedReasoningLevels: policy.allowedReasoningLevels,
  };
}

async function setTabFeatureState(tabId, patch) {
  await initializeTabFeatureRuntime();
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw Object.assign(new Error('没有打开的 ChatGPT 标签页'), { code: 'NO_CHATGPT_TAB' });
  const next = normalizeState({ ...DEFAULT_TAB_FEATURE_STATE, ...states.get(id), ...patch });
  states.set(id, next);
  await persistStates();
  log('tab_feature_changed', { tabId: id, ...next });
  return next;
}

async function removeTabState(tabId, reason = 'tab_removed') {
  await initializeTabFeatureRuntime();
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  tabWindowIds.delete(id);
  const changed = states.delete(id);
  if (changed) await persistStates();
  log('tab_feature_removed', { tabId: id, reason, changed });
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

async function targetTabId(preferred = null, sender = null) {
  if (Number.isInteger(preferred)) {
    try {
      const tab = await chrome.tabs.get(preferred);
      if (isChatGptUrl(tab?.url)) {
        rememberTabWindow(tab);
        return preferred;
      }
    } catch {}
  }
  if (Number.isInteger(sender?.tab?.id) && isChatGptUrl(sender.tab.url)) {
    rememberTabWindow(sender.tab);
    return sender.tab.id;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (Number.isInteger(active?.id) && isChatGptUrl(active?.url)) {
    rememberTabWindow(active);
    return active.id;
  }
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.forEach(rememberTabWindow);
  tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
  return Number.isInteger(tabs[0]?.id) ? tabs[0].id : null;
}

function accountAllowsWindow(account, windowId) {
  if (account?.authenticated !== true || account?.entitlement?.active !== true) return false;
  if (!Number.isInteger(windowId)) return true;
  const windowKey = `chrome:${windowId}`;
  const allowed = Array.isArray(account.allowedWindowKeys) ? account.allowedWindowKeys : [];
  const denied = Array.isArray(account.deniedWindowKeys) ? account.deniedWindowKeys : [];
  if (!allowed.length && !denied.length) return true;
  return allowed.includes(windowKey) && !denied.includes(windowKey);
}

async function backgroundState(tabId) {
  // The account client persists the authoritative snapshot before login/heartbeat
  // resolves. Feature state stays tab-scoped; windowId is consulted only for the
  // account's concurrent-window allowance.
  const stored = await chrome.storage.local.get(ACCOUNT_SNAPSHOT_KEY);
  const account = stored?.[ACCOUNT_SNAPSHOT_KEY] ?? {
    authenticated: false,
    authorized: false,
    allowedWindowKeys: [],
    deniedWindowKeys: [],
  };
  const windowId = Number.isInteger(tabId) ? await resolveWindowIdForTab(tabId) : null;
  return {
    account,
    accountWindowAllowed: accountAllowsWindow(account, windowId),
    settings: { enabled: masterEnabled },
  };
}

function entitlementError(state) {
  const account = state?.account;
  if (account?.authenticated !== true) {
    return Object.assign(new Error('请先登录或注册 GPTWork'), { code: 'AUTH_REQUIRED' });
  }
  if (account?.entitlement?.active !== true) {
    return Object.assign(new Error('当前账号没有有效权益'), { code: 'ENTITLEMENT_REQUIRED' });
  }
  return null;
}

function quotaExceeded(state, tabId) {
  return Number.isInteger(tabId)
    && state?.account?.authenticated === true
    && state?.account?.entitlement?.active === true
    && state?.accountWindowAllowed === false;
}

async function pushFeatureState(tabId, featureState = null) {
  if (!Number.isInteger(tabId)) return;
  const state = featureState || await getTabFeatureState(tabId);
  const policy = effectivePolicyForTabSync(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTWORK_TAB_FEATURE_STATE',
      featureState: state,
      policy,
    });
  } catch {}
  if (masterEnabled) return;
  // Master OFF must fail open immediately in already-loaded content scripts. Do not
  // leave a previously cached blocking guard alive until its heartbeat expires.
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTLOCK_GUARD_STATE',
      state: {
        phase: 'initial',
        guard: {
          canSend: true,
          allowKind: 'disabled',
          status: 'disabled',
          reason: 'gptlock_disabled',
        },
      },
      policy,
      settings: { enabled: false },
    });
  } catch {}
}

async function pushAllFeatureStates() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); } catch {}
  for (const tab of tabs) rememberTabWindow(tab);
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => pushFeatureState(tab.id)));
}

async function featureSnapshot(tabId) {
  const state = await backgroundState(tabId);
  const windowId = Number.isInteger(tabId) ? await resolveWindowIdForTab(tabId) : null;
  const featureState = Number.isInteger(tabId) ? await getTabFeatureState(tabId) : normalizeState(null);
  return {
    tabId,
    windowId,
    featureState,
    policy: Number.isInteger(tabId) ? effectivePolicyForTabSync(tabId) : basePolicy,
    settings: state?.settings ?? null,
    account: state?.account ?? null,
    accountWindowAllowed: Number.isInteger(tabId) ? state?.accountWindowAllowed !== false : true,
    windowQuotaExceeded: quotaExceeded(state, tabId),
    masterEnabled,
  };
}

async function disabledMasterSnapshot(tabId) {
  const windowId = Number.isInteger(tabId) ? await resolveWindowIdForTab(tabId) : null;
  const featureState = Number.isInteger(tabId) ? await getTabFeatureState(tabId) : normalizeState(null);
  return {
    tabId,
    windowId,
    featureState,
    policy: Number.isInteger(tabId) ? effectivePolicyForTabSync(tabId) : basePolicy,
    settings: { enabled: false },
    account: null,
    accountWindowAllowed: true,
    windowQuotaExceeded: false,
    masterEnabled: false,
  };
}

async function handleFeatureMessage(message, sender) {
  const tabId = await targetTabId(message.tabId, sender);
  if (message.type === 'GPTWORK_TAB_FEATURE_GET') return featureSnapshot(tabId);

  if (message.type === 'GPTWORK_TAB_FEATURE_SET') {
    if (!Number.isInteger(tabId)) throw Object.assign(new Error('没有打开的 ChatGPT 标签页'), { code: 'NO_CHATGPT_TAB' });
    const state = await backgroundState(tabId);
    if (message.enabled === true) {
      const denied = entitlementError(state);
      if (denied) throw denied;
      if (quotaExceeded(state, tabId)) {
        throw Object.assign(new Error(WINDOW_QUOTA_MESSAGE), { code: 'WINDOW_QUOTA_EXCEEDED' });
      }
    }
    const patch = message.feature === 'work'
      ? { workModeEnabled: message.enabled === true }
      : message.feature === 'model'
        ? { modelLockEnabled: message.enabled === true }
        : null;
    if (!patch) throw Object.assign(new Error('未知功能开关'), { code: 'INVALID_FEATURE' });
    const featureState = await setTabFeatureState(tabId, patch);
    await pushFeatureState(tabId, featureState);
    await scheduleAccountRefresh();
    return featureSnapshot(tabId);
  }

  if (message.type === 'GPTWORK_MASTER_STATUS') return featureSnapshot(tabId);

  if (message.type === 'GPTWORK_MASTER_SET') {
    const desired = message.enabled === true;
    if (!desired) {
      masterEnabled = false;
      await chrome.storage.local.set({ [MASTER_KEY]: false });
      log('master_changed', { enabled: false, tabId });
      return disabledMasterSnapshot(tabId);
    }

    const state = await backgroundState(tabId);
    const denied = entitlementError(state);
    if (denied) throw denied;
    if (quotaExceeded(state, tabId)) {
      throw Object.assign(new Error(WINDOW_QUOTA_MESSAGE), { code: 'WINDOW_QUOTA_EXCEEDED' });
    }
    await chrome.storage.local.set({ [MASTER_KEY]: true });
    masterEnabled = true;
    log('master_changed', { enabled: true, tabId });
    return { ...(await featureSnapshot(tabId)), masterEnabled: true };
  }

  throw new Error(`Unsupported tab feature message: ${message.type}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!FEATURE_MESSAGE_TYPES.has(message?.type)) return false;
  handleFeatureMessage(message, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    }),
  );
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  rememberTabWindow(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabState(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (Number.isInteger(tab?.windowId)) rememberTabWindow(tab);
  if (changeInfo.url && !isChatGptUrl(changeInfo.url)) {
    void removeTabState(tabId, 'left_chatgpt').catch(() => {});
  }
});

if (chrome.tabs.onAttached?.addListener) {
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    if (Number.isInteger(tabId) && Number.isInteger(attachInfo?.newWindowId)) {
      tabWindowIds.set(tabId, attachInfo.newWindowId);
      // Moving a tab does not adopt another tab's state. The same tab keeps its own
      // Work/Model choices and only its quota window identity changes.
      void pushFeatureState(tabId).catch(() => {});
    }
  });
}

if (chrome.tabs.onDetached?.addListener) {
  chrome.tabs.onDetached.addListener((tabId) => {
    tabWindowIds.delete(Number(tabId));
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[MASTER_KEY]) {
    masterEnabled = changes[MASTER_KEY].newValue === true;
    void pushAllFeatureStates().catch(() => {});
    return;
  }
  if (areaName !== 'sync') return;
  let changed = false;
  if (changes.policy) {
    basePolicy = normalizePolicy(changes.policy.newValue);
    if (!selectionWriteInFlight) {
      const nextSelection = normalizeModels(basePolicy.lockedModels);
      if (nextSelection.length) {
        modelLockSelection = nextSelection;
        if (!changes[MODEL_SELECTION_KEY]) {
          selectionWriteInFlight = true;
          void chrome.storage.sync.set({ [MODEL_SELECTION_KEY]: nextSelection })
            .catch(() => {})
            .finally(() => { selectionWriteInFlight = false; });
        }
      }
    }
    changed = true;
  }
  if (changes[MODEL_SELECTION_KEY]) {
    modelLockSelection = normalizeModels(changes[MODEL_SELECTION_KEY].newValue);
    changed = true;
  }
  if (changes[DISCOVERED_MODELS_KEY]) {
    discoveredModels = normalizeModels(changes[DISCOVERED_MODELS_KEY].newValue);
    changed = true;
  }
  if (!changed) return;
  void pushAllFeatureStates().catch(() => {});
});

void initializeTabFeatureRuntime().catch((error) => {
  log('initialize_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
});
