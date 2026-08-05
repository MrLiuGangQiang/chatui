'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { redactString } = require('./safe-log');

const TRACE_SCHEMA_VERSION = 'request_trace.v1';
const DEFAULT_TRACE_RELATIVE_PATH = path.join('temp', 'request-trace.ndjson');
const DEFAULT_TRACE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TRACE_ROTATIONS = 3;
const DEFAULT_TEXT_LIMIT = 16 * 1024;
const DEFAULT_MESSAGE_LIMIT = 12;
const ROUTE_MESSAGE_LIMIT = 20;
const BINARY_FIELD_RE = /^(?:b64(?:_json)?|base64|file_data|image_data|audio_data|input_audio|bytes)$/i;
const CREDENTIAL_FIELD_RE = /api[_-]?key|authorization|secret|password|cookie|set-cookie|access[_-]?token|refresh[_-]?token/i;

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function requestTraceEnabled(env = process.env) {
  return envFlag(env.CHATUI_REQUEST_TRACE, false);
}

function sanitizeTarget(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return redactString(String(value || '')).split('?')[0].split('#')[0];
  }
}

function normalizeSecrets(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value || ''))
    .filter(value => value.length >= 4))];
}

function redactSecrets(value = '', secrets = []) {
  let text = String(value || '');
  for (const secret of normalizeSecrets(secrets)) text = text.split(secret).join('[redacted]');
  return redactString(text);
}

function traceText(value = '', { maxChars = DEFAULT_TEXT_LIMIT, secrets = [], includeText = true } = {}) {
  const original = String(value ?? '');
  const redacted = redactSecrets(original, secrets);
  const limit = positiveInteger(maxChars, DEFAULT_TEXT_LIMIT);
  const truncated = redacted.length > limit;
  return {
    chars: original.length,
    ...(includeText ? { text: truncated ? `${redacted.slice(0, limit)}…[truncated]` : redacted } : {}),
    truncated,
  };
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function summarizeSystemContent(content) {
  let serialized;
  try { serialized = typeof content === 'string' ? content : JSON.stringify(content); }
  catch { serialized = String(content || ''); }
  return { chars: serialized.length, sha256: hashText(serialized), omitted: true };
}

function summarizeRemoteValue(value = '') {
  const text = String(value || '');
  if (!text) return { source: 'empty', chars: 0 };
  if (/^data:/i.test(text)) return { source: 'data_url', chars: text.length, redacted: true };
  if (/^[A-Za-z0-9+/=\r\n]{4096,}$/.test(text)) return { source: 'base64', chars: text.length, redacted: true };
  return { source: 'url', target: sanitizeTarget(text), chars: text.length };
}

function summarizeContentPart(part = {}, options = {}) {
  if (!part || typeof part !== 'object') return traceText(part, options);
  const type = String(part.type || 'unknown');
  if (['text', 'input_text', 'output_text'].includes(type) || Object.prototype.hasOwnProperty.call(part, 'text')) {
    return { type, ...traceText(part.text || '', options) };
  }
  if (['image_url', 'input_image', 'output_image'].includes(type) || part.image_url || part.image) {
    const source = part.image_url?.url || part.image_url || part.image || part.url || '';
    return { type, media: 'image', ...summarizeRemoteValue(source) };
  }
  if (type === 'input_file' || part.file_data) {
    return {
      type: 'input_file',
      filename: String(part.filename || part.name || ''),
      detail: String(part.detail || ''),
      fileDataChars: String(part.file_data || '').length,
      fileDataRedacted: !!part.file_data,
    };
  }
  if (type === 'input_audio' || part.audio_data) {
    return { type: 'input_audio', dataChars: String(part.audio_data || part.data || '').length, dataRedacted: true };
  }
  return { type, fields: Object.keys(part).slice(0, 20) };
}

function selectedMessages(messages = [], limit = DEFAULT_MESSAGE_LIMIT) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= limit) return { messages: list, omitted: 0 };
  const tailCount = Math.max(1, limit - (list[0]?.role === 'system' ? 1 : 0));
  const selected = list[0]?.role === 'system'
    ? [list[0], ...list.slice(-tailCount)]
    : list.slice(-limit);
  return { messages: selected, omitted: Math.max(0, list.length - selected.length) };
}

function summarizeMessages(messages = [], { kind = '', includeText = true, secrets = [] } = {}) {
  const routeLike = ['route_decision', 'semantic_task'].includes(kind);
  const { messages: selected, omitted } = selectedMessages(messages, routeLike ? ROUTE_MESSAGE_LIMIT : DEFAULT_MESSAGE_LIMIT);
  return {
    count: Array.isArray(messages) ? messages.length : 0,
    omitted,
    items: selected.map((message, index) => {
      const role = String(message?.role || '');
      const content = message?.content;
      if (role === 'system') return { index, role, content: summarizeSystemContent(content) };
      if (Array.isArray(content)) {
        return {
          index,
          role,
          content: content.slice(0, 50).map(part => summarizeContentPart(part, {
            maxChars: routeLike ? DEFAULT_TEXT_LIMIT : 4096,
            secrets,
            includeText,
          })),
          omittedParts: Math.max(0, content.length - 50),
        };
      }
      return {
        index,
        role,
        content: traceText(content, {
          maxChars: routeLike ? DEFAULT_TEXT_LIMIT : 4096,
          secrets,
          includeText,
        }),
      };
    }),
  };
}

function summarizeResponsesInput(input = [], options = {}) {
  if (typeof input === 'string') return traceText(input, options);
  if (!Array.isArray(input)) return { count: 0, items: [] };
  const { messages, omitted } = selectedMessages(input, DEFAULT_MESSAGE_LIMIT);
  return {
    count: input.length,
    omitted,
    items: messages.map((item, index) => {
      const role = String(item?.role || item?.type || '');
      if (role === 'system') return { index, role, content: summarizeSystemContent(item?.content) };
      const content = Array.isArray(item?.content) ? item.content : [item?.content];
      return {
        index,
        role,
        content: content.filter(value => value !== undefined && value !== null).slice(0, 50)
          .map(part => typeof part === 'object'
            ? summarizeContentPart(part, options)
            : traceText(part, { ...options, maxChars: 4096 })),
      };
    }),
  };
}

function responseFormatSummary(value = null) {
  if (!value || typeof value !== 'object') return null;
  return {
    type: String(value.type || ''),
    name: String(value.json_schema?.name || ''),
    strict: value.json_schema?.strict === true,
  };
}

function requestKind(targetPath = '', payload = {}, fallback = '') {
  const pathText = String(targetPath || '').toLowerCase();
  if (fallback) return String(fallback);
  if (pathText.includes('/images/edits') || pathText.includes('/openai/image_edit')) return 'image_edit';
  if (pathText.includes('/images/generations')) return 'image_generation';
  if (pathText === '/image' || pathText.endsWith('/api/image')) return 'image_download';
  if (pathText.includes('/models')) return 'model_list';
  const schemaName = String(payload?.response_format?.json_schema?.name || '').toLowerCase();
  const systemText = Array.isArray(payload?.messages)
    ? payload.messages.filter(message => message?.role === 'system').map(message => String(message?.content || '')).join('\n')
    : '';
  if (/semantic_task|route|intent/.test(schemaName) || /semantic_task\.v\d+|route_decision\.v\d+|语义路由器/.test(systemText)) return 'route_decision';
  if (pathText.includes('/responses')) return 'chat_responses';
  if (pathText.includes('/chat/completions')) return 'chat_completions';
  return 'upstream_request';
}

function summarizeRequestPayload(payload = {}, {
  kind = '', targetPath = '', includeText = true, secrets = [], fileCount = 0, maskCount = 0,
} = {}) {
  const resolvedKind = kind || requestKind(targetPath, payload);
  const out = {
    model: String(payload?.model || ''),
    stream: payload?.stream === true,
    fields: Object.keys(payload || {}).filter(key => !BINARY_FIELD_RE.test(key)).slice(0, 80),
  };
  const responseFormat = responseFormatSummary(payload?.response_format);
  if (responseFormat) out.responseFormat = responseFormat;
  for (const key of ['n', 'size', 'quality', 'background', 'output_format', 'format', 'seed']) {
    if (payload?.[key] !== undefined && payload?.[key] !== null && payload?.[key] !== '') out[key] = payload[key];
  }
  if (payload?.reasoning && typeof payload.reasoning === 'object') {
    out.reasoning = {
      effort: String(payload.reasoning.effort || ''),
      summary: String(payload.reasoning.summary || ''),
    };
  }
  if (Array.isArray(payload?.messages)) out.messages = summarizeMessages(payload.messages, { kind: resolvedKind, includeText, secrets });
  if (payload?.input !== undefined) out.input = summarizeResponsesInput(payload.input, { includeText, secrets, maxChars: 4096 });
  if (payload?.prompt !== undefined) out.prompt = traceText(payload.prompt, { includeText, secrets, maxChars: DEFAULT_TEXT_LIMIT });
  if (payload?.image_role_map !== undefined) out.imageRoleMap = traceText(
    typeof payload.image_role_map === 'string' ? payload.image_role_map : JSON.stringify(payload.image_role_map),
    { includeText, secrets, maxChars: 4096 },
  );
  if (Array.isArray(payload?.tools)) {
    out.tools = payload.tools.slice(0, 30).map(tool => String(tool?.function?.name || tool?.name || tool?.type || ''));
    out.omittedTools = Math.max(0, payload.tools.length - 30);
  }
  if (fileCount) out.fileCount = Number(fileCount);
  if (maskCount) out.maskCount = Number(maskCount);
  return out;
}

function summarizeReasoning(value) {
  if (value === undefined || value === null || value === '') return null;
  let serialized;
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { serialized = String(value || ''); }
  return { present: true, chars: serialized.length, omitted: true };
}

function summarizeToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).slice(0, 20).map(call => ({
    id: String(call?.id || ''),
    type: String(call?.type || ''),
    name: String(call?.function?.name || call?.name || ''),
    argumentChars: String(call?.function?.arguments || call?.arguments || '').length,
  }));
}

function summarizeChoice(choice = {}, options = {}) {
  const message = choice?.message || choice?.delta || {};
  const content = message?.content;
  const summarizedContent = Array.isArray(content)
    ? content.slice(0, 50).map(part => summarizeContentPart(part, options))
    : traceText(content ?? message?.text ?? '', options);
  const reasoning = summarizeReasoning(message?.reasoning_content || message?.reasoning);
  return {
    index: Number(choice?.index) || 0,
    finishReason: String(choice?.finish_reason || ''),
    message: {
      role: String(message?.role || ''),
      content: summarizedContent,
      ...(reasoning ? { reasoning } : {}),
      ...(Array.isArray(message?.tool_calls) ? { toolCalls: summarizeToolCalls(message.tool_calls) } : {}),
    },
  };
}

function summarizeImageItem(item = {}, options = {}) {
  if (typeof item === 'string') return summarizeRemoteValue(item);
  const b64 = item?.b64_json || item?.b64 || item?.image_base64 || '';
  const url = item?.url || item?.src || item?.image_url || '';
  return {
    ...(b64 ? { image: { source: 'base64', chars: String(b64).length, redacted: true } } : {}),
    ...(!b64 && url ? { image: summarizeRemoteValue(url) } : {}),
    ...(item?.revised_prompt ? { revisedPrompt: traceText(item.revised_prompt, options) } : {}),
    fields: Object.keys(item || {}).filter(key => !BINARY_FIELD_RE.test(key)).slice(0, 30),
  };
}

function numericUsage(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([, item]) => Number.isFinite(Number(item)));
  return entries.length ? Object.fromEntries(entries.map(([key, item]) => [key, Number(item)])) : null;
}

function redactTraceEvent(value, depth = 0, key = '') {
  if (CREDENTIAL_FIELD_RE.test(String(key || ''))) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= 12) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactTraceEvent(item, depth + 1));
  const out = {};
  for (const [itemKey, itemValue] of Object.entries(value).slice(0, 120)) {
    if (BINARY_FIELD_RE.test(itemKey)) {
      out[itemKey] = { chars: typeof itemValue === 'string' ? itemValue.length : 0, redacted: true };
      continue;
    }
    out[itemKey] = redactTraceEvent(itemValue, depth + 1, itemKey);
  }
  return out;
}

function sanitizeGeneric(value, { secrets = [], depth = 0 } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return traceText(value, { maxChars: 4096, secrets });
  if (typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? { arrayCount: value.length, omitted: true } : { objectOmitted: true };
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeGeneric(item, { secrets, depth: depth + 1 }));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (BINARY_FIELD_RE.test(key)) {
      out[key] = { chars: typeof item === 'string' ? item.length : 0, redacted: true };
      continue;
    }
    out[key] = sanitizeGeneric(item, { secrets, depth: depth + 1 });
  }
  return redactTraceEvent(out);
}

function summarizeResponsePayload(value, {
  kind = '', contentType = '', includeText = true, secrets = [],
} = {}) {
  let data = value;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed && (String(contentType).includes('json') || /^[\[{]/.test(trimmed))) {
      try { data = JSON.parse(trimmed); } catch {}
    }
  }
  if (typeof data === 'string') return { body: traceText(data, { includeText, secrets, maxChars: DEFAULT_TEXT_LIMIT }) };
  if (!data || typeof data !== 'object') return { value: data ?? null };
  const out = {
    fields: Object.keys(data).filter(key => !BINARY_FIELD_RE.test(key)).slice(0, 80),
  };
  if (data.id) out.id = String(data.id);
  if (data.model) out.model = String(data.model);
  if (Array.isArray(data.choices)) {
    out.choices = data.choices.slice(0, 4).map(choice => summarizeChoice(choice, { includeText, secrets, maxChars: DEFAULT_TEXT_LIMIT }));
    out.omittedChoices = Math.max(0, data.choices.length - 4);
  }
  if (data.output_text !== undefined) out.outputText = traceText(data.output_text, { includeText, secrets, maxChars: DEFAULT_TEXT_LIMIT });
  if (Array.isArray(data.data) || Array.isArray(data.images)) {
    const images = Array.isArray(data.data) ? data.data : data.images;
    out.images = { count: images.length, items: images.slice(0, 8).map(item => summarizeImageItem(item, { includeText, secrets, maxChars: 4096 })) };
  }
  if (data.error) out.error = sanitizeGeneric(data.error, { secrets });
  else if (data.message && !data.choices) out.message = traceText(data.message, { includeText, secrets, maxChars: 4096 });
  const usage = numericUsage(data.usage);
  if (usage) out.usage = usage;
  if (!out.choices && !out.images && out.outputText === undefined && !out.error && !out.message) {
    out.summary = sanitizeGeneric(data, { secrets });
  }
  if (kind) out.kind = kind;
  return out;
}

function traceId() {
  if (typeof crypto.randomUUID === 'function') return `trace-${crypto.randomUUID()}`;
  return `trace-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function resolveTraceFile({ root = path.resolve(__dirname, '../..'), env = process.env, filePath = '' } = {}) {
  const configured = String(filePath || env.CHATUI_REQUEST_TRACE_FILE || DEFAULT_TRACE_RELATIVE_PATH).trim();
  return path.resolve(root, configured || DEFAULT_TRACE_RELATIVE_PATH);
}

function createRequestTraceLogger({
  root = path.resolve(__dirname, '../..'),
  env = process.env,
  enabled = requestTraceEnabled(env),
  filePath = '',
  maxBytes = positiveInteger(env.CHATUI_REQUEST_TRACE_MAX_BYTES, DEFAULT_TRACE_MAX_BYTES),
  rotations = positiveInteger(env.CHATUI_REQUEST_TRACE_ROTATIONS, DEFAULT_TRACE_ROTATIONS, 0, 20),
  includeText = envFlag(env.CHATUI_REQUEST_TRACE_TEXT, true),
  now = () => Date.now(),
  onError = error => console.warn('[request-trace] write failed:', error?.message || error),
} = {}) {
  const resolvedFile = resolveTraceFile({ root, env, filePath });
  const normalizedMaxBytes = positiveInteger(maxBytes, DEFAULT_TRACE_MAX_BYTES);
  const normalizedRotations = positiveInteger(rotations, DEFAULT_TRACE_ROTATIONS, 0, 20);
  let warned = false;

  function reportError(error) {
    if (warned) return;
    warned = true;
    try { onError(error); } catch {}
  }

  function rotate(incomingBytes) {
    let currentBytes = 0;
    try { currentBytes = fs.statSync(resolvedFile).size; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (currentBytes + incomingBytes <= normalizedMaxBytes) return;
    if (normalizedRotations === 0) {
      fs.writeFileSync(resolvedFile, '', 'utf8');
      return;
    }
    for (let index = normalizedRotations; index >= 1; index -= 1) {
      const source = index === 1 ? resolvedFile : `${resolvedFile}.${index - 1}`;
      const target = `${resolvedFile}.${index}`;
      if (!fs.existsSync(source)) continue;
      if (index === normalizedRotations && fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    }
  }

  function write(event = {}) {
    if (!enabled) return false;
    try {
      fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
      const timestampMs = Number(event.timestamp_ms) || now();
      const line = `${JSON.stringify({
        schema_version: TRACE_SCHEMA_VERSION,
        timestamp: new Date(timestampMs).toISOString(),
        ...redactTraceEvent(event),
        timestamp_ms: timestampMs,
      })}\n`;
      rotate(Buffer.byteLength(line, 'utf8'));
      fs.appendFileSync(resolvedFile, line, 'utf8');
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function begin({
    source = 'proxy', requestId = '', jobId = '', method = 'POST', target = '', targetPath = '',
    payload = {}, kind = '', headerNames = [], queryKeys = [], fileCount = 0, maskCount = 0, secrets = [],
  } = {}) {
    if (!enabled) return null;
    const startedAt = now();
    const resolvedKind = requestKind(targetPath, payload, kind);
    const span = {
      id: String(requestId || traceId()),
      startedAt,
      closed: false,
      kind: resolvedKind,
      secrets: normalizeSecrets(secrets),
      source: String(source || 'proxy'),
      jobId: String(jobId || ''),
    };
    write({
      event: 'request.started',
      trace_id: span.id,
      source: span.source,
      kind: resolvedKind,
      ...(span.jobId ? { job_id: span.jobId } : {}),
      method: String(method || 'POST').toUpperCase(),
      target: sanitizeTarget(target),
      target_path: String(targetPath || ''),
      header_names: [...new Set((Array.isArray(headerNames) ? headerNames : []).map(value => String(value || '')).filter(Boolean))],
      query_keys: [...new Set((Array.isArray(queryKeys) ? queryKeys : []).map(value => String(value || '')).filter(Boolean))],
      request: summarizeRequestPayload(payload, {
        kind: resolvedKind,
        targetPath,
        includeText,
        secrets: span.secrets,
        fileCount,
        maskCount,
      }),
      timestamp_ms: startedAt,
    });
    return span;
  }

  function closeSpan(span, event, {
    status = 0, response = null, responseText = undefined, contentType = '', error = null, durationMs = null,
  } = {}) {
    if (!enabled || !span || span.closed) return false;
    span.closed = true;
    const finishedAt = now();
    const duration = Number.isFinite(Number(durationMs))
      ? Math.max(0, Number(durationMs))
      : Math.max(0, finishedAt - Number(span.startedAt || finishedAt));
    const details = {
      event,
      trace_id: span.id,
      source: span.source,
      kind: span.kind,
      ...(span.jobId ? { job_id: span.jobId } : {}),
      status: Number(status) || 0,
      duration_ms: Math.round(duration),
      timestamp_ms: finishedAt,
    };
    const responseValue = responseText !== undefined ? responseText : response;
    if (responseValue !== undefined && responseValue !== null) {
      details.response = summarizeResponsePayload(responseValue, {
        kind: span.kind,
        contentType,
        includeText,
        secrets: span.secrets,
      });
    }
    if (error) {
      details.error = {
        name: String(error?.name || ''),
        code: String(error?.code || error?.cause?.code || ''),
        message: traceText(error?.message || error, { includeText: true, secrets: span.secrets, maxChars: 4096 }),
      };
    }
    return write(details);
  }

  function complete(span, details = {}) {
    return closeSpan(span, 'request.completed', details);
  }

  function fail(span, details = {}) {
    return closeSpan(span, 'request.failed', details);
  }

  return Object.freeze({
    enabled: !!enabled,
    filePath: resolvedFile,
    includeText: !!includeText,
    maxBytes: normalizedMaxBytes,
    rotations: normalizedRotations,
    record: write,
    begin,
    complete,
    fail,
  });
}

module.exports = {
  TRACE_SCHEMA_VERSION,
  DEFAULT_TRACE_RELATIVE_PATH,
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_TRACE_ROTATIONS,
  requestTraceEnabled,
  sanitizeTarget,
  redactSecrets,
  traceText,
  requestKind,
  summarizeRequestPayload,
  summarizeResponsePayload,
  resolveTraceFile,
  createRequestTraceLogger,
};

