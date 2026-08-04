(function initChatUIProblemFeedbackCore(root) {
  'use strict';

  const DEFAULT_RECENT_ROUNDS = 3;
  const DEFAULT_REPRODUCTION_MAX = 1380;
  const DEFAULT_MESSAGE_MAX = 140;
  const DATA_URL_RE = /data:[^\s,;]+(?:;[^\s,;]+)*;base64,[a-z0-9+/=]+/gi;
  const BLOB_URL_RE = /blob:[^\s)\]}>"']+/gi;
  const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
  const API_KEY_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g;
  const SECRET_FIELD_RE = /((?:api[_-]?key|authorization|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi;
  const JSON_SECRET_FIELD_RE = /(["']?(?:api[_-]?key|authorization|token|password|secret)["']?\s*:\s*["'])[^"']+(["'])/gi;

  function truncateText(value = '', maxChars = 240) {
    const text = String(value || '');
    const limit = Math.max(1, Number(maxChars) || 1);
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
  }

  function redactSensitiveText(value = '') {
    return String(value || '')
      .replace(DATA_URL_RE, '[内嵌文件数据已省略]')
      .replace(BLOB_URL_RE, '[临时文件地址已省略]')
      .replace(BEARER_RE, 'Bearer [已隐藏]')
      .replace(API_KEY_RE, '[API Key 已隐藏]')
      .replace(JSON_SECRET_FIELD_RE, '$1[已隐藏]$2')
      .replace(SECRET_FIELD_RE, '$1[已隐藏]');
  }

  function normalizeDiagnosticText(value = '', maxChars = 480) {
    return truncateText(
      redactSensitiveText(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      maxChars,
    );
  }

  function contentText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value.map(part => {
        if (!part || typeof part !== 'object') return contentText(part);
        const type = String(part.type || '').toLowerCase();
        if (/image|file|audio|video/.test(type)) {
          const name = String(part.filename || part.name || part.file?.name || '').trim();
          return name ? `[附件：${name}]` : '[附件已省略]';
        }
        return contentText(part.text ?? part.content ?? part.output_text ?? part.message ?? '');
      }).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
      return contentText(value.text ?? value.content ?? value.output_text ?? value.message ?? value.rawText ?? '');
    }
    return String(value);
  }

  function messageText(message = {}, maxChars = DEFAULT_MESSAGE_MAX) {
    const value = message.rawText ?? message.content ?? message.text ?? message.presentation?.displayText ?? '';
    return normalizeDiagnosticText(contentText(value), maxChars);
  }

  function conversationSource(session = {}) {
    if (Array.isArray(session.messages) && session.messages.length) return session.messages;
    if (Array.isArray(session.display) && session.display.length) return session.display;
    return [];
  }

  function collectConversationRounds(session = {}, options = {}) {
    const maxRounds = Math.max(1, Number(options.maxRounds) || DEFAULT_RECENT_ROUNDS);
    const messageMaxChars = Math.max(40, Number(options.messageMaxChars) || DEFAULT_MESSAGE_MAX);
    const rounds = [];
    let current = null;

    for (const message of conversationSource(session)) {
      const role = String(message?.role || '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const text = messageText(message, messageMaxChars);
      if (!text) continue;
      if (role === 'user') {
        current = { user: text, assistants: [] };
        rounds.push(current);
      } else {
        if (!current) {
          current = { user: '', assistants: [] };
          rounds.push(current);
        }
        current.assistants.push(text);
      }
    }
    return rounds.slice(-maxRounds);
  }

  function buildConversationExcerpt(session = {}, options = {}) {
    const maxChars = Math.max(120, Number(options.maxChars) || 820);
    const rounds = collectConversationRounds(session, options);
    if (!rounds.length) return '最近会话：暂无可用的用户消息或助手答复。';
    const totalRounds = conversationSource(session).filter(message => String(message?.role || '').toLowerCase() === 'user' && messageText(message)).length || rounds.length;
    const startIndex = Math.max(1, totalRounds - rounds.length + 1);
    const lines = [`最近 ${rounds.length} 轮会话（自动填写）`];
    rounds.forEach((round, index) => {
      lines.push(`第 ${startIndex + index} 轮`);
      if (round.user) lines.push(`用户：${round.user}`);
      if (round.assistants.length) lines.push(`助手：${round.assistants.join(' / ')}`);
      else lines.push('助手：[本轮未产生正常答复]');
    });
    return truncateText(lines.join('\n'), maxChars);
  }

  function responseMessage(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return '';
    try {
      const payload = JSON.parse(normalized);
      return normalizeDiagnosticText(
        payload?.error?.message || payload?.error?.code || payload?.message || payload?.reason || payload?.detail || normalized,
        420,
      );
    } catch {
      return normalizeDiagnosticText(normalized, 420);
    }
  }

  function sanitizeRequestUrl(value = '', baseUrl = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const absoluteInput = /^[a-z][a-z0-9+.-]*:/i.test(raw);
      const parsed = new URL(raw, baseUrl || 'http://chatui.local');
      const base = baseUrl ? new URL(baseUrl) : null;
      const sameOrigin = Boolean(base && parsed.origin === base.origin);
      return `${!absoluteInput || sameOrigin ? '' : parsed.origin}${parsed.pathname}` || '/';
    } catch {
      return normalizeDiagnosticText(raw.split(/[?#]/)[0], 240);
    }
  }

  function normalizeIncident(input = {}) {
    const error = input?.error;
    const message = normalizeDiagnosticText(
      input.message || responseMessage(input.responseText) || error?.message || error || input.statusText || '检测到未说明的异常',
      480,
    );
    const hasStatus = input.status !== null && input.status !== undefined && String(input.status).trim() !== '';
    const status = hasStatus ? Number(input.status) : Number.NaN;
    return {
      id: String(input.id || ''),
      kind: String(input.kind || (Number.isFinite(status) ? 'http' : 'runtime')),
      source: normalizeDiagnosticText(input.source || '', 120),
      message,
      method: String(input.method || '').trim().toUpperCase(),
      url: sanitizeRequestUrl(input.url || '', input.baseUrl || ''),
      status: Number.isFinite(status) ? status : null,
      statusText: normalizeDiagnosticText(input.statusText || '', 100),
      occurredAt: Number(input.occurredAt) || Date.now(),
    };
  }

  function incidentProblem(incident = {}) {
    if (incident.kind === 'http') {
      const status = incident.status ? `HTTP ${incident.status}${incident.statusText ? ` ${incident.statusText}` : ''}` : '非正常响应';
      return truncateText(`请求返回${status}${incident.message ? `：${incident.message}` : ''}`, 1360);
    }
    if (incident.kind === 'network') return truncateText(`网络请求失败：${incident.message}`, 1360);
    if (incident.kind === 'resource') return truncateText(`页面资源加载失败：${incident.message}`, 1360);
    if (incident.kind === 'ui') return truncateText(`操作未正常完成：${incident.message}`, 1360);
    return truncateText(`应用发生异常：${incident.message}`, 1360);
  }

  function buildIncidentReproduction(incident = {}, session = {}, options = {}) {
    const normalized = normalizeIncident(incident);
    const details = [
      '【自动捕获信息，可在提交前编辑】',
      `时间：${new Date(normalized.occurredAt).toISOString()}`,
      normalized.source ? `来源：${normalized.source}` : '',
      normalized.method || normalized.url ? `请求：${[normalized.method, normalized.url].filter(Boolean).join(' ')}` : '',
      normalized.status ? `状态：HTTP ${normalized.status}${normalized.statusText ? ` ${normalized.statusText}` : ''}` : '',
      normalized.message ? `异常：${normalized.message}` : '',
      '',
      buildConversationExcerpt(session, {
        maxRounds: options.maxRounds || DEFAULT_RECENT_ROUNDS,
        maxChars: options.conversationMaxChars || 820,
        messageMaxChars: options.messageMaxChars || DEFAULT_MESSAGE_MAX,
      }),
    ].filter((line, index, all) => line || (index > 0 && all[index - 1])).join('\n');
    return truncateText(details, options.maxChars || DEFAULT_REPRODUCTION_MAX);
  }

  function buildIncidentDraft(incident = {}, session = {}, options = {}) {
    const normalized = normalizeIncident(incident);
    return {
      problem: incidentProblem(normalized),
      reproduction: buildIncidentReproduction(normalized, session, options),
      expected: '当前操作应正常完成并返回可用结果；若确实无法完成，应给出明确且可恢复的提示，并保留当前会话内容。',
    };
  }

  function incidentFingerprint(incident = {}) {
    const normalized = normalizeIncident(incident);
    return [normalized.kind, normalized.status || '', normalized.method, normalized.url, normalized.message.toLowerCase()].join('|');
  }

  const api = Object.freeze({
    DEFAULT_RECENT_ROUNDS,
    DEFAULT_REPRODUCTION_MAX,
    truncateText,
    redactSensitiveText,
    normalizeDiagnosticText,
    contentText,
    messageText,
    collectConversationRounds,
    buildConversationExcerpt,
    responseMessage,
    sanitizeRequestUrl,
    normalizeIncident,
    buildIncidentReproduction,
    buildIncidentDraft,
    incidentFingerprint,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('problemFeedbackCore', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
