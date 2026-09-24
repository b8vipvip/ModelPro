export function observationMatchesPolicy(observation, policy) {
  return Boolean(
    observation?.model
      && observation?.reasoning
      && policy.lockedModels.includes(observation.model)
      && policy.allowedReasoningLevels.includes(observation.reasoning),
  );
}

export function observationConflictsPolicy(observation, policy) {
  return Boolean(
    (observation?.model && !policy.lockedModels.includes(observation.model))
      || (observation?.reasoning && !policy.allowedReasoningLevels.includes(observation.reasoning)),
  );
}

function verificationReasons(state) {
  return Array.isArray(state.lastVerification?.reasons) ? state.lastVerification.reasons : [];
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function mismatchAppliesToLatestRequest(state) {
  const verifiedAt = timestamp(state.lastVerification?.verifiedAt);
  const requestAt = timestamp(state.lastRequest?.capturedAt);
  if (requestAt === null) return verifiedAt !== null;
  if (verifiedAt === null) return false;
  return verifiedAt >= requestAt;
}

function hasConfirmedModelMismatch(state, policy) {
  if (state.phase !== 'mismatch' || !verificationReasons(state).includes('model_not_allowed')) return false;

  // A reason code is only authoritative while its concrete model is still disallowed.
  // This prevents an old mismatch reason from surviving a policy change while the
  // current response model is now explicitly allowed (for example GPT-5.6 Sol).
  const verifiedModel = state.lastVerification?.model;
  if (!verifiedModel || policy.lockedModels.includes(verifiedModel)) return false;

  // A strict-mode block is turn-scoped. Never let an older response mismatch block
  // a newer formal request. Missing correlation data fails open instead of making a
  // stale browser-page listener permanently disable ChatGPT sending.
  return mismatchAppliesToLatestRequest(state);
}

function autoVerificationAppliesToLatestRequest(state) {
  const completedAt = Date.parse(state.autoVerification?.completedAt || '');
  const latestRequestAt = Date.parse(state.lastRequest?.capturedAt || '');
  if (!Number.isFinite(completedAt)) return false;
  return !Number.isFinite(latestRequestAt) || latestRequestAt <= completedAt;
}

function hasConfirmedAutoVerification(state, policy) {
  const auto = state.autoVerification;
  return Boolean(
    auto
      && !auto.running
      && auto.outcome === 'verified'
      && auto.evidenceSource === 'network_response_metadata'
      && auto.responseModel
      && auto.responseReasoning
      && policy.lockedModels.includes(auto.responseModel)
      && policy.allowedReasoningLevels.includes(auto.responseReasoning)
      && autoVerificationAppliesToLatestRequest(state),
  );
}

export function evaluateGuard({ state, policy, settings, inScope = true }) {
  const strict = policy.strictMode;
  const uiMatches = observationMatchesPolicy(state.pageObservation, policy);
  const uiConflicts = observationConflictsPolicy(state.pageObservation, policy);
  const uiComplete = Boolean(state.pageObservation?.model && state.pageObservation?.reasoning);
  const base = {
    strictMode: strict,
    canSend: true,
    allowKind: 'locked',
    status: state.phase,
    uiMatches,
    uiConflicts,
    uiComplete,
    reason: null,
  };

  if (!inScope) {
    return { ...base, allowKind: 'outside_scope', status: 'outside_scope' };
  }
  if (!settings.enabled) {
    return {
      ...base,
      allowKind: 'disabled',
      status: 'disabled',
      reason: 'gptlock_disabled',
    };
  }

  // A confirmed mismatch may block only the request it actually belongs to.
  if (strict && hasConfirmedModelMismatch(state, policy)) {
    return {
      ...base,
      canSend: false,
      allowKind: 'blocked',
      status: 'mismatch',
      reason: 'model_not_allowed',
    };
  }

  if (!state.monitor?.attached) {
    return {
      ...base,
      allowKind: 'warning',
      status: 'monitor_offline',
      reason: state.monitor?.error || 'network_monitor_not_attached',
    };
  }
  if (!settings.networkVerificationEnabled) {
    return {
      ...base,
      allowKind: 'locked',
      status: 'verification_disabled',
      reason: 'response_verification_disabled',
    };
  }
  if (!state.core?.connected) {
    return {
      ...base,
      allowKind: 'warning',
      status: 'core_offline',
      reason: state.core?.error || 'native_core_offline',
    };
  }

  // Auto verification is a turn-level result. ChatGPT can emit additional WebSocket
  // frames after the model-bearing frame; those frames often contain no model fields.
  // Keep the verified result sticky only for the same turn, when it was backed by
  // network response metadata and both model and reasoning still satisfy the policy.
  if (hasConfirmedAutoVerification(state, policy)) {
    return { ...base, allowKind: 'locked', status: 'verified' };
  }

  if (state.phase === 'verified') {
    return { ...base, allowKind: 'locked', status: 'verified' };
  }
  if (state.phase === 'waiting') {
    return {
      ...base,
      allowKind: 'locked',
      status: 'waiting',
      reason: 'waiting_for_response_metadata',
    };
  }
  if (state.phase === 'mismatch') {
    return {
      ...base,
      allowKind: 'warning',
      status: 'mismatch',
      reason: state.lastVerification?.reason || 'policy_mismatch',
    };
  }
  if (state.phase === 'unverified') {
    return {
      ...base,
      allowKind: 'warning',
      status: 'unverified',
      reason: state.lastVerification?.reason || 'metadata_missing',
    };
  }
  if (state.phase === 'error') {
    return {
      ...base,
      allowKind: 'warning',
      status: 'error',
      reason: state.lastError || 'verification_error',
    };
  }
  if (uiConflicts) {
    return {
      ...base,
      allowKind: 'warning',
      status: 'preflight_mismatch',
      reason: 'page_selection_not_allowed',
    };
  }
  if (!uiComplete) {
    return {
      ...base,
      allowKind: 'locked',
      status: 'lock_ready',
      reason: 'page_selection_missing',
    };
  }
  return { ...base, allowKind: 'locked', status: 'lock_ready' };
}
