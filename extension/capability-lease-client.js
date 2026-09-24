const EXPIRY_SAFETY_MS = 5_000;

function required(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new TypeError(`invalid capability lease ${name}`);
  return text;
}

export function createCapabilityLeaseStore() {
  let identity = null;
  let lease = null;

  function setIdentity(value = {}) {
    identity = {
      deviceId: required(value.deviceId, 'deviceId'),
      browserInstanceId: required(value.browserInstanceId, 'browserInstanceId'),
      extensionId: required(value.extensionId, 'extensionId', 64),
    };
    return { ...identity };
  }

  function setLease(value) {
    if (!value?.leaseToken || !value?.expiresAt) {
      lease = null;
      return null;
    }
    const expiresAtMs = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new TypeError('invalid capability lease expiry');
    const windowKeys = [...new Set(Array.isArray(value.windowKeys)
      ? value.windowKeys.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256).slice(0, 64)
      : [])];
    lease = {
      leaseToken: required(value.leaseToken, 'token', 16_384),
      expiresAtMs,
      windowKeys,
    };
    return { expiresAt: new Date(expiresAtMs).toISOString(), windowKeys: [...windowKeys] };
  }

  function clearLease() {
    lease = null;
  }

  function envelope(windowKey, nowMs = Date.now()) {
    if (!identity) {
      const error = new Error('Capability lease identity is unavailable');
      error.code = 'capability_lease_identity_unavailable';
      throw error;
    }
    if (!lease || lease.expiresAtMs <= nowMs + EXPIRY_SAFETY_MS) {
      const error = new Error('Capability lease is missing or expired');
      error.code = 'capability_lease_unavailable';
      throw error;
    }
    const key = required(windowKey, 'windowKey');
    if (!lease.windowKeys.includes(key)) {
      const error = new Error('Capability lease does not admit this window');
      error.code = 'capability_lease_window_denied';
      throw error;
    }
    return {
      capabilityLease: lease.leaseToken,
      leaseBinding: { ...identity, windowKey: key },
    };
  }

  function snapshot(nowMs = Date.now()) {
    return {
      identityReady: Boolean(identity),
      leaseReady: Boolean(lease && lease.expiresAtMs > nowMs + EXPIRY_SAFETY_MS),
      expiresAt: lease ? new Date(lease.expiresAtMs).toISOString() : null,
      windowKeys: lease ? [...lease.windowKeys] : [],
    };
  }

  function reset() {
    identity = null;
    lease = null;
  }

  return { setIdentity, setLease, clearLease, envelope, snapshot, reset };
}

const sharedStore = createCapabilityLeaseStore();

export const setCapabilityLeaseIdentity = (value) => sharedStore.setIdentity(value);
export const setCapabilityLease = (value) => sharedStore.setLease(value);
export const clearCapabilityLease = () => sharedStore.clearLease();
export const capabilityLeaseEnvelope = (windowKey, nowMs) => sharedStore.envelope(windowKey, nowMs);
export const capabilityLeaseSnapshot = (nowMs) => sharedStore.snapshot(nowMs);
export const resetCapabilityLeaseForTest = () => sharedStore.reset();
