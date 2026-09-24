export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';
export const ACCOUNT_REFRESH_SOON_MS = 250;
export const ACCOUNT_REFRESH_PERIOD_MINUTES = 1;
export const MASTER_KEY = 'gptworkEnabledLocal';

async function masterRuntimeEnabled(chromeApi) {
  // Unit callers and non-extension harnesses may intentionally provide only alarms.
  // In the real extension, storage.local is always available and is authoritative.
  if (!chromeApi?.storage?.local?.get) return true;
  try {
    const stored = await chromeApi.storage.local.get(MASTER_KEY);
    return stored?.[MASTER_KEY] === true;
  } catch {
    // Fail closed for recurring background work. The user can still re-enable the
    // master switch, which writes the key and schedules a fresh heartbeat.
    return false;
  }
}

export async function scheduleAccountRefresh(chromeApi = globalThis.chrome, delayMs = ACCOUNT_REFRESH_SOON_MS) {
  if (!chromeApi?.alarms?.create) throw new Error('Account refresh alarm is unavailable');
  if (!await masterRuntimeEnabled(chromeApi)) {
    try { await chromeApi.alarms.clear?.(ACCOUNT_REFRESH_ALARM); } catch {}
    return false;
  }
  await chromeApi.alarms.create(ACCOUNT_REFRESH_ALARM, {
    when: Date.now() + Math.max(0, Number(delayMs) || 0),
    periodInMinutes: ACCOUNT_REFRESH_PERIOD_MINUTES,
  });
  return true;
}
