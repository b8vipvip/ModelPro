import {
  modelTransportId,
  normalizeModelId,
  normalizeReasoningLevel,
  prioritizeModels,
} from './policy.js';

const MODEL_KEYS = new Set([
  'model_slug',
  'modelslug',
  'model_id',
  'modelid',
  'used_model',
  'resolved_model',
  'resolved_model_slug',
  'served_model',
  'served_model_slug',
  'used_model_slug',
  'default_model_slug',
  'model',
]);
const SERVED_MODEL_KEYS = new Set([
  'used_model',
  'used_model_slug',
  'resolved_model',
  'resolved_model_slug',
  'served_model',
  'served_model_slug',
]);
const FALLBACK_MODEL_KEYS = new Set(['default_model_slug']);
const REASONING_KEYS = new Set([
  'reasoning_effort',
  'reasoningeffort',
  'reasoning_level',
  'reasoninglevel',
  'thinking_level',
  'thinkinglevel',
  'thinking_effort',
]);
const SKIPPED_CONTENT_KEYS = new Set([
  'content',
  'parts',
  'text',
  'prompt',
  'input',
  'output_text',
  'arguments',
]);
const EMBEDDED_STREAM_KEYS = new Set(['encoded_item']);
const MODEL_HEADERS = [
  'x-openai-model',
  'openai-model',
  'x-gpt-model',
  'x-model',
];
const REASONING_HEADERS = [
  'x-openai-reasoning-effort',
  'x-reasoning-effort',
  'x-reasoning-level',
];
const OFFICIAL_CONVERSATION_PATHS = new Set([
  '/backend-api/conversation',
  '/backend-api/f/conversation',
]);
const MAX_WALK_DEPTH = 14;
const MAX_BODY_CHARS = 16 * 1024 * 1024;

function canonicalKey(value) {
  return String(value).trim().toLowerCase().replace(/[-.]/g, '_');
}

function modelFrom(value) {
  if (typeof value !== 'string') return null;
  return normalizeModelId(value);
}

function reasoningFrom(value) {
  if (typeof value !== 'string') return null;
  return normalizeReasoningLevel(value);
}

function pathScore(path, key, kind, mode = 'response') {
  const normalizedPath = path.map(canonicalKey);
  const metadata = normalizedPath.some((part) => /metadata|details|response/.test(part));
  if (kind === 'model') {
    if (mode === 'request') {
      if (key === 'model' && path.length === 0) return 140;
      return 0;
    }
    // Response verification has one terminal authority: fields whose semantics
    // explicitly say what backend model served/resolved/was used for this turn.
    // message.metadata.model_slug is page/default/routing metadata in live traffic
    // and MUST NOT become served-model proof (v0.5.126 field evidence showed it
    // falsely reporting Sol for an Astra request).
    if (SERVED_MODEL_KEYS.has(key)) return 130;
    return 0;
  }
  return metadata ? 115 : path.length <= 3 ? 95 : 0;
}

function collectCandidates(value, candidates, path = [], depth = 0, mode = 'response') {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectCandidates(value[index], candidates, [...path, String(index)], depth + 1, mode);
    }
    return;
  }

  for (const [rawKey, child] of Object.entries(value)) {
    const key = canonicalKey(rawKey);
    const nextPath = [...path, rawKey];
    if (MODEL_KEYS.has(key)) {
      const model = modelFrom(child);
      const score = pathScore(path, key, 'model', mode);
      if (model && score > 0) candidates.model.push({ value: model, score, path: nextPath.join('.') });
    }
    if (REASONING_KEYS.has(key)) {
      const reasoning = reasoningFrom(child);
      const score = pathScore(path, key, 'reasoning');
      if (reasoning && score > 0) candidates.reasoning.push({ value: reasoning, score, path: nextPath.join('.') });
    }
    if (!SKIPPED_CONTENT_KEYS.has(key)) {
      collectCandidates(child, candidates, nextPath, depth + 1, mode);
    }
  }
}

function selectCandidate(candidates) {
  if (!candidates.length) return { value: null, conflict: false, path: null };
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  const bestValues = [...new Set(best.map((candidate) => candidate.value))];
  if (bestValues.length !== 1) return { value: null, conflict: true, path: null };
  return { value: bestValues[0], conflict: false, path: best[best.length - 1].path };
}

function inspectObjects(values, mode = 'response') {
  const candidates = { model: [], reasoning: [] };
  for (const value of values) collectCandidates(value, candidates, [], 0, mode);
  const model = selectCandidate(candidates.model);
  const reasoning = selectCandidate(candidates.reasoning);
  return {
    model: model.value,
    reasoning: reasoning.value,
    conflicts: {
      model: model.conflict,
      reasoning: reasoning.conflict,
    },
    fields: {
      model: model.path,
      reasoning: reasoning.path,
    },
    diagnostics: {
      modelCandidateCount: candidates.model.length,
      reasoningCandidateCount: candidates.reasoning.length,
      modelCandidatePaths: [...new Set(candidates.model.map((candidate) => candidate.path))].slice(-12),
      reasoningCandidatePaths: [...new Set(candidates.reasoning.map((candidate) => candidate.path))].slice(-12),
      modelCandidateValues: [...new Set(candidates.model.map((candidate) => candidate.value))].slice(-12),
      reasoningCandidateValues: [...new Set(candidates.reasoning.map((candidate) => candidate.value))].slice(-12),
    },
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseSseObjects(body) {
  const objects = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    const parsed = parseJson(data);
    if (parsed && typeof parsed === 'object') objects.push(parsed);
  };

  for (const line of String(body).split(/\r?\n/)) {
    if (line === '') {
      flush();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return objects;
}


function collectEmbeddedStreamObjects(value, objects, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) collectEmbeddedStreamObjects(child, objects, depth + 1);
    return;
  }
  for (const [rawKey, child] of Object.entries(value)) {
    const key = canonicalKey(rawKey);
    if (EMBEDDED_STREAM_KEYS.has(key) && typeof child === 'string' && child.length <= MAX_BODY_CHARS) {
      const trimmed = child.trim();
      const parsed = parseJson(trimmed);
      if (parsed && typeof parsed === 'object') {
        objects.push(parsed);
        collectEmbeddedStreamObjects(parsed, objects, depth + 1);
      }
      const sseObjects = parseSseObjects(trimmed);
      if (sseObjects.length) {
        objects.push(...sseObjects);
        for (const object of sseObjects) collectEmbeddedStreamObjects(object, objects, depth + 1);
      }
      continue;
    }
    if (!SKIPPED_CONTENT_KEYS.has(key)) collectEmbeddedStreamObjects(child, objects, depth + 1);
  }
}

export function extractStreamHandoff(body = '') {
  const objects = parseSseObjects(body);
  let resumeToken = null;
  let conversationId = null;
  let handoff = null;
  for (const value of objects) {
    if (value?.type === 'resume_conversation_token') {
      if (typeof value.token === 'string' && value.token) resumeToken = value.token;
      if (typeof value.conversation_id === 'string' && value.conversation_id) {
        conversationId = value.conversation_id;
      }
    }
    if (value?.type === 'stream_handoff') handoff = value;
  }
  if (!handoff) return null;
  const options = Array.isArray(handoff.options) ? handoff.options : [];
  const topicIds = [...new Set(options
    .map((option) => (typeof option?.topic_id === 'string' ? option.topic_id : null))
    .filter(Boolean))];
  const transports = [...new Set(options
    .map((option) => (typeof option?.type === 'string' ? option.type : null))
    .filter(Boolean))];
  return {
    conversationId: typeof handoff.conversation_id === 'string'
      ? handoff.conversation_id
      : conversationId,
    turnExchangeId: typeof handoff.turn_exchange_id === 'string'
      ? handoff.turn_exchange_id
      : null,
    topicIds,
    transports,
    resumeToken,
    resumeTokenPresent: Boolean(resumeToken),
  };
}

export function publicStreamHandoff(handoff) {
  if (!handoff) return null;
  return {
    conversationId: handoff.conversationId ?? null,
    turnExchangeId: handoff.turnExchangeId ?? null,
    topicIds: Array.isArray(handoff.topicIds) ? handoff.topicIds : [],
    transports: Array.isArray(handoff.transports) ? handoff.transports : [],
    resumeTokenPresent: Boolean(handoff.resumeTokenPresent || handoff.resumeToken),
  };
}

export function streamPayloadMatches(payload, handoff) {
  const text = typeof payload === 'string' ? payload : String(payload ?? '');
  if (!text || !handoff) return false;
  const markers = [
    handoff.conversationId,
    handoff.turnExchangeId,
    handoff.resumeToken,
    ...(Array.isArray(handoff.topicIds) ? handoff.topicIds : []),
  ].filter((value) => typeof value === 'string' && value.length >= 8);
  return markers.some((marker) => text.includes(marker));
}

function inspectBody(body, mimeType = '') {
  const bodyLength = typeof body === 'string' ? body.length : 0;
  if (typeof body !== 'string' || !body) {
    return { values: [], diagnostics: { bodyLength, bodyFormat: 'empty', parsedObjectCount: 0 } };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { values: [], diagnostics: { bodyLength, bodyFormat: 'too_large', parsedObjectCount: 0 } };
  }
  const trimmed = body.trim();
  const values = [];
  const formats = [];
  const whole = parseJson(trimmed);
  if (whole && typeof whole === 'object') {
    values.push(whole);
    formats.push('json');
  }
  if (/event-stream/i.test(mimeType) || /(^|\n)data:/.test(trimmed)) {
    const objects = parseSseObjects(trimmed);
    values.push(...objects);
    if (objects.length) formats.push('sse');
  }
  if (!values.length && trimmed.includes('\n')) {
    for (const line of trimmed.split(/\r?\n/)) {
      const parsed = parseJson(line.trim());
      if (parsed && typeof parsed === 'object') values.push(parsed);
    }
    if (values.length) formats.push('ndjson');
  }
  const embedded = [];
  for (const value of [...values]) collectEmbeddedStreamObjects(value, embedded);
  if (embedded.length) {
    values.push(...embedded);
    formats.push('embedded-sse');
  }
  return {
    values,
    diagnostics: {
      bodyLength,
      bodyFormat: formats.join('+') || 'unparsed',
      parsedObjectCount: values.length,
    },
  };
}

function normalizeHeaders(headers) {
  const normalized = new Map();
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (header?.name && typeof header.value === 'string') {
        normalized.set(header.name.toLowerCase(), header.value);
      }
    }
  } else if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') normalized.set(name.toLowerCase(), value);
    }
  }
  return normalized;
}

export function extractHeaderEvidence(headers) {
  const normalized = normalizeHeaders(headers);
  let model = null;
  let modelHeader = null;
  let reasoning = null;
  let reasoningHeader = null;
  for (const name of MODEL_HEADERS) {
    const value = modelFrom(normalized.get(name));
    if (value) {
      model = value;
      modelHeader = name;
      break;
    }
  }
  for (const name of REASONING_HEADERS) {
    const value = reasoningFrom(normalized.get(name));
    if (value) {
      reasoning = value;
      reasoningHeader = name;
      break;
    }
  }
  return {
    model,
    reasoning,
    conflicts: { model: false, reasoning: false },
    fields: { model: modelHeader, reasoning: reasoningHeader },
  };
}

function mergeEvidence(headerEvidence, bodyEvidence) {
  const modelConflict = Boolean(
    headerEvidence.model && bodyEvidence.model && headerEvidence.model !== bodyEvidence.model,
  ) || headerEvidence.conflicts.model || bodyEvidence.conflicts.model;
  const reasoningConflict = Boolean(
    headerEvidence.reasoning && bodyEvidence.reasoning && headerEvidence.reasoning !== bodyEvidence.reasoning,
  ) || headerEvidence.conflicts.reasoning || bodyEvidence.conflicts.reasoning;
  return {
    model: modelConflict ? null : headerEvidence.model || bodyEvidence.model,
    reasoning: reasoningConflict ? null : headerEvidence.reasoning || bodyEvidence.reasoning,
    conflicts: { model: modelConflict, reasoning: reasoningConflict },
    fields: {
      model: headerEvidence.fields.model || bodyEvidence.fields.model,
      reasoning: headerEvidence.fields.reasoning || bodyEvidence.fields.reasoning,
    },
  };
}

export function extractResponseEvidence({ body = '', headers = {}, mimeType = '' } = {}) {
  const headerEvidence = extractHeaderEvidence(headers);
  const inspectedBody = inspectBody(body, mimeType);
  const bodyEvidence = inspectObjects(inspectedBody.values);
  return {
    ...mergeEvidence(headerEvidence, bodyEvidence),
    evidenceSource: 'network_response_metadata',
    diagnostics: {
      mimeType: String(mimeType || ''),
      ...inspectedBody.diagnostics,
      ...bodyEvidence.diagnostics,
      matchedHeaderFields: [headerEvidence.fields.model, headerEvidence.fields.reasoning].filter(Boolean),
    },
  };
}

export function extractRequestEvidence(postData = '') {
  const parsed = typeof postData === 'string' ? parseJson(postData) : null;
  const evidence = inspectObjects(parsed && typeof parsed === 'object' ? [parsed] : [], 'request');
  return {
    ...evidence,
    evidenceSource: 'network_request_metadata',
    diagnostics: {
      postDataLength: typeof postData === 'string' ? postData.length : 0,
      parsedObjectCount: parsed && typeof parsed === 'object' ? 1 : 0,
      ...evidence.diagnostics,
    },
  };
}

function normalizedUnique(values, normalize) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalize).filter(Boolean))];
}

function reasoningTransportValue(level, rawKey) {
  if (level !== 'extra-high') return level;
  return canonicalKey(rawKey).includes('thinking') ? 'xhigh' : 'extra_high';
}

export function rewriteConversationPostData(postData = '', configuration = {}) {
  const result = {
    postData: typeof postData === 'string' ? postData : '',
    changed: false,
    reason: null,
    modelBefore: null,
    modelAfter: null,
    transportModelBefore: null,
    transportModelAfter: null,
    reasoningBefore: null,
    reasoningAfter: null,
    reasoningFields: [],
  };
  const parsed = typeof postData === 'string' ? parseJson(postData) : null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.reason = 'request_body_not_json_object';
    return result;
  }

  const lockedModels = prioritizeModels(normalizedUnique(configuration.lockedModels, normalizeModelId));
  if (!lockedModels.length) {
    result.reason = 'no_locked_model';
    return result;
  }
  if (typeof parsed.model !== 'string') {
    result.reason = 'top_level_model_missing';
    return result;
  }

  result.transportModelBefore = parsed.model;
  result.modelBefore = normalizeModelId(parsed.model);
  // The page-selected request model is authoritative only when it belongs to the
  // known-model catalog. This preserves the user's visible ChatGPT selection while
  // still preventing an unknown/untrusted model id from bypassing the lock policy.
  // If the page model is unknown, fall back to the strongest explicit locked model.
  const knownModels = new Set(normalizedUnique(configuration.knownModels, normalizeModelId));
  const pageSelectedKnown = Boolean(result.modelBefore && knownModels.has(result.modelBefore));
  const forcedModel = normalizeModelId(configuration.forceModel);
  const forceKnownModel = Boolean(forcedModel && knownModels.has(forcedModel));
  const targetModel = forceKnownModel ? forcedModel : pageSelectedKnown ? result.modelBefore : lockedModels[0];
  const preserveModel = configuration.preserveModel === true || (!forceKnownModel && pageSelectedKnown);
  const targetTransport = preserveModel
    ? parsed.model
    : result.modelBefore === targetModel
      ? parsed.model
      : modelTransportId(targetModel);
  if (!targetTransport) {
    result.reason = 'locked_model_invalid';
    return result;
  }
  if (!preserveModel && parsed.model !== targetTransport) {
    parsed.model = targetTransport;
    result.changed = true;
  }
  result.transportModelAfter = parsed.model;
  result.modelAfter = normalizeModelId(parsed.model);

  const allowedReasoning = normalizedUnique(
    configuration.allowedReasoningLevels,
    normalizeReasoningLevel,
  );
  const preferredReasoning = normalizeReasoningLevel(configuration.preferredReasoning);
  const preserveReasoning = configuration.preserveReasoning === true;
  const targetReasoning = preserveReasoning
    ? null
    : preferredReasoning && allowedReasoning.includes(preferredReasoning)
      ? preferredReasoning
      : allowedReasoning[0] ?? null;

  const reasoningValues = [];
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (!REASONING_KEYS.has(canonicalKey(rawKey)) || typeof rawValue !== 'string') continue;
    result.reasoningFields.push(rawKey);
    const current = normalizeReasoningLevel(rawValue);
    reasoningValues.push(current);
    if (targetReasoning && current !== targetReasoning) {
      parsed[rawKey] = reasoningTransportValue(targetReasoning, rawKey);
      result.changed = true;
    }
  }
  result.reasoningBefore = reasoningValues.find(Boolean) ?? null;
  result.reasoningAfter = result.reasoningFields.length
    ? normalizeReasoningLevel(parsed[result.reasoningFields[0]])
    : null;

  if (result.changed) result.postData = JSON.stringify(parsed);
  result.reason = forceKnownModel
    ? (result.changed ? 'verification_model_forced' : 'verification_model_already_exact')
    : configuration.preserveModel === true
      ? 'verification_model_passthrough'
      : pageSelectedKnown
        ? 'page_selected_known_model_locked'
        : result.changed ? 'rewritten' : 'already_locked';
  return result;
}

export function isChatGptConversationRequest(url, method = 'GET') {
  if (String(method).toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'chatgpt.com'
      && OFFICIAL_CONVERSATION_PATHS.has(parsed.pathname);
  } catch {
    return false;
  }
}

export function decodeCdpBody(body, base64Encoded) {
  if (!base64Encoded) return typeof body === 'string' ? body : '';
  try {
    const binary = atob(String(body));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}