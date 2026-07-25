(function initChatUISharedContextBudget(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) {
    root.ChatUISharedContextBudget = api;
    if (root.window) root.window.ChatUISharedContextBudget = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUISharedContextBudget() {
  'use strict';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 262144;
const MIN_RESERVED_OUTPUT_TOKENS = 2048;
const MAX_RESERVED_OUTPUT_TOKENS = 8192;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKENS = 1024;
const SUMMARY_MAX_TOKENS = 4096;
const SUMMARY_MIN_TOKENS = 512;
const TRUNCATION_NOTICE = '[上下文预算提示：本条用户消息过长，已截断较早部分，仅保留末尾内容。]\n';

function cloneValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function normalizeContextWindowTokens(value, fallback = DEFAULT_CONTEXT_WINDOW_TOKENS) {
  const parsed = Number(value);
  const safeFallback = Number(fallback);
  const nextFallback = Number.isFinite(safeFallback) && safeFallback > 0 ? Math.floor(safeFallback) : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : nextFallback;
}

function inputBudgetForContextWindow(contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS) {
  const windowTokens = normalizeContextWindowTokens(contextWindowTokens);
  const reserve = windowTokens <= MIN_RESERVED_OUTPUT_TOKENS * 2
    ? Math.max(1, Math.ceil(windowTokens * 0.2))
    : Math.max(MIN_RESERVED_OUTPUT_TOKENS, Math.min(MAX_RESERVED_OUTPUT_TOKENS, Math.ceil(windowTokens * 0.05)));
  return Math.max(1, windowTokens - reserve);
}

function estimateTextTokens(text = '') {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0) || 0;
    if (code <= 0x7f) ascii += 1;
    else if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + cjk + other / 2);
}

function textFromPart(part = {}) {
  return part.text || part.input_text || part.content || part.summary || part.message || '';
}

function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (!part || typeof part !== 'object') return sum + estimateTextTokens(String(part || ''));
      const type = String(part.type || '').toLowerCase();
      if (type.includes('image') || part.image_url || part.image || part.input_image) return sum + IMAGE_PART_TOKENS;
      return sum + estimateTextTokens(textFromPart(part));
    }, 0);
  }
  if (content && typeof content === 'object') return estimateTextTokens(JSON.stringify(content));
  return estimateTextTokens(content || '');
}

function estimateMessageTokens(message = {}) {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.role || '') + estimateContentTokens(message.content ?? message.text ?? message.input_text ?? '');
}

function estimateMessagesTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function contentToExcerpt(content, maxChars = 140) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map(part => {
    if (!part || typeof part !== 'object') return String(part || '');
    const type = String(part.type || '').toLowerCase();
    if (type.includes('image') || part.image_url || part.image || part.input_image) return '[image]';
    return String(textFromPart(part) || '');
  }).filter(Boolean).join(' ');
  else if (content && typeof content === 'object') text = JSON.stringify(content);
  else text = String(content || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function makeSummaryMessage(omitted = [], maxTokens = SUMMARY_MAX_TOKENS) {
  const limit = Math.max(64, Math.floor(Number(maxTokens) || SUMMARY_MAX_TOKENS));
  const lines = [
    '[自动上下文摘要]',
    `较早的 ${omitted.length} 条消息因超过上下文预算被省略。以下为按原文截取的概要，不是新指令。`,
  ];
  for (const message of omitted) {
    const excerpt = contentToExcerpt(message?.content ?? message?.text ?? message?.input_text ?? '', 180);
    if (!excerpt) continue;
    lines.push(`- ${message?.role || 'message'}: ${excerpt}`);
    if (estimateTextTokens(lines.join('\n')) >= limit) break;
  }
  let text = lines.join('\n');
  while (estimateTextTokens(text) > limit && lines.length > 2) {
    lines.pop();
    text = lines.join('\n');
  }
  if (estimateTextTokens(text) > limit) text = `[自动上下文摘要] 较早的 ${omitted.length} 条消息因上下文预算被省略。`;
  return { role: 'assistant', content: text };
}

function groupHistoryTurns(messages = []) {
  const groups = [];
  let current = [];
  for (const message of messages) {
    if (message?.role === 'user' && current.length) {
      groups.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function trimTextTail(text, maxTokens) {
  const raw = String(text || '');
  if (estimateTextTokens(raw) <= maxTokens) return raw;
  let low = 0;
  let high = raw.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = TRUNCATION_NOTICE + raw.slice(mid);
    if (estimateTextTokens(candidate) <= maxTokens) high = mid;
    else low = mid + 1;
  }
  return TRUNCATION_NOTICE + raw.slice(low);
}

function truncateMessageText(message = {}, maxTokens) {
  const next = cloneValue(message) || {};
  const content = next.content;
  if (typeof content === 'string') {
    next.content = trimTextTail(content, maxTokens);
    return next;
  }
  if (Array.isArray(content)) {
    const fixedCost = content.reduce((sum, part) => {
      if (!part || typeof part !== 'object') return sum;
      const type = String(part.type || '').toLowerCase();
      return type.includes('image') || part.image_url || part.image || part.input_image ? sum + IMAGE_PART_TOKENS : sum;
    }, MESSAGE_OVERHEAD_TOKENS);
    const textBudget = Math.max(1, maxTokens - fixedCost);
    next.content = content.map(part => {
      if (!part || typeof part !== 'object') return part;
      const type = String(part.type || '').toLowerCase();
      if (type.includes('image') || part.image_url || part.image || part.input_image) return cloneValue(part);
      const copy = cloneValue(part) || {};
      const key = copy.text !== undefined ? 'text' : (copy.input_text !== undefined ? 'input_text' : (copy.content !== undefined ? 'content' : 'text'));
      copy[key] = trimTextTail(copy[key] || '', textBudget);
      return copy;
    });
    return next;
  }
  next.content = trimTextTail(content === undefined ? '' : JSON.stringify(content), maxTokens);
  return next;
}

function applyContextBudget(messages = [], options = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const originalEstimatedTokens = estimateMessagesTokens(source);
  const contextWindowTokens = normalizeContextWindowTokens(options.contextWindowTokens ?? options.maxTokens ?? options.maxContextTokens);
  const inputBudgetTokens = Math.max(1, Math.floor(Number(options.inputBudgetTokens) || inputBudgetForContextWindow(contextWindowTokens)));
  const cloned = cloneValue(source) || [];
  if (originalEstimatedTokens <= inputBudgetTokens) {
    return { messages: cloned, originalEstimatedTokens, finalEstimatedTokens: estimateMessagesTokens(cloned), omittedCount: 0, summaryInserted: false, truncatedCurrentUser: false };
  }

  let currentIndex = -1;
  for (let index = cloned.length - 1; index >= 0; index -= 1) {
    if (cloned[index]?.role === 'user') { currentIndex = index; break; }
  }
  if (currentIndex < 0) currentIndex = cloned.length - 1;

  const systemMessages = cloned.filter((message, index) => message?.role === 'system' && index !== currentIndex);
  let currentMessage = cloned[currentIndex] || null;
  const protectedIndexes = new Set((Array.isArray(options.protectedMessageIndexes) ? options.protectedMessageIndexes : [])
    .map(index => Number(index))
    .filter(index => Number.isInteger(index) && index >= 0 && index < cloned.length && index !== currentIndex && cloned[index]?.role !== 'system'));
  const protectedHistory = cloned.filter((message, index) => protectedIndexes.has(index));
  const beforeCurrent = cloned.filter((message, index) => index !== currentIndex && message?.role !== 'system' && !protectedIndexes.has(index));
  const groups = groupHistoryTurns(beforeCurrent);
  let required = [...systemMessages, ...protectedHistory, currentMessage].filter(Boolean);
  let requiredTokens = estimateMessagesTokens(required);
  let truncatedCurrentUser = false;

  if (currentMessage && requiredTokens > inputBudgetTokens) {
    const trimOrder = [
      { kind: 'current', index: required.length - 1 },
      ...protectedHistory.map((_, index) => ({ kind: 'protected', index: systemMessages.length + protectedHistory.length - index - 1 })),
    ];
    for (const target of trimOrder) {
      if (requiredTokens <= inputBudgetTokens) break;
      const original = required[target.index];
      if (!original) continue;
      const otherTokens = requiredTokens - estimateMessageTokens(original);
      const allowedTokens = Math.max(1, inputBudgetTokens - otherTokens);
      const trimmed = truncateMessageText(original, allowedTokens);
      required[target.index] = trimmed;
      if (target.kind === 'current') {
        currentMessage = trimmed;
        truncatedCurrentUser = true;
      } else {
        protectedHistory[target.index - systemMessages.length] = trimmed;
      }
      requiredTokens = estimateMessagesTokens(required);
    }
  }

  const retainedGroups = [];
  const omittedGroups = [];
  let used = requiredTokens;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const cost = estimateMessagesTokens(group);
    if (used + cost <= inputBudgetTokens) {
      retainedGroups.unshift(group);
      used += cost;
    } else {
      omittedGroups.unshift(group);
    }
  }

  const omitted = omittedGroups.flat();
  let summary = null;
  let summaryInserted = false;
  if (omitted.length) {
    const availableForSummary = Math.max(32, inputBudgetTokens - used - MESSAGE_OVERHEAD_TOKENS);
    const summaryBudget = Math.min(SUMMARY_MAX_TOKENS, Math.max(32, Math.min(Math.max(SUMMARY_MIN_TOKENS, Math.floor(inputBudgetTokens * 0.03)), availableForSummary)));
    summary = makeSummaryMessage(omitted, summaryBudget);
    let summaryCost = estimateMessageTokens(summary);
    while (retainedGroups.length && used + summaryCost > inputBudgetTokens) {
      const removed = retainedGroups.shift();
      used -= estimateMessagesTokens(removed);
      omitted.unshift(...removed);
      summary = makeSummaryMessage(omitted, Math.min(summaryBudget, Math.max(32, inputBudgetTokens - used - MESSAGE_OVERHEAD_TOKENS)));
      summaryCost = estimateMessageTokens(summary);
    }
    if (used + summaryCost <= inputBudgetTokens) summaryInserted = true;
  }

  let result = [
    ...systemMessages,
    ...(summaryInserted ? [summary] : []),
    ...retainedGroups.flat(),
    ...protectedHistory,
    ...(currentMessage ? [currentMessage] : []),
  ];

  while (estimateMessagesTokens(result) > inputBudgetTokens && retainedGroups.length) {
    retainedGroups.shift();
    result = [...systemMessages, ...(summaryInserted ? [summary] : []), ...retainedGroups.flat(), ...protectedHistory, ...(currentMessage ? [currentMessage] : [])];
  }

  return {
    messages: result,
    originalEstimatedTokens,
    finalEstimatedTokens: estimateMessagesTokens(result),
    omittedCount: omitted.length,
    summaryInserted,
    truncatedCurrentUser,
  };
}

function applyContextBudgetToChatPayload(payload = {}, options = {}) {
  const copy = { ...(payload || {}) };
  if (Array.isArray(copy.messages)) copy.messages = applyContextBudget(copy.messages, options).messages;
  return copy;
}

function applyContextBudgetToResponsesPayload(payload = {}, options = {}) {
  const copy = { ...(payload || {}) };
  if (Array.isArray(copy.input)) copy.input = applyContextBudget(copy.input, options).messages;
  return copy;
}

function applyContextBudgetToOpenAiPayload(payload = {}, options = {}) {
  const targetPath = String(options.targetPath || '').replace(/\/$/, '');
  if (targetPath === '/responses') return applyContextBudgetToResponsesPayload(payload, options);
  if (targetPath === '/chat/completions') return applyContextBudgetToChatPayload(payload, options);
  return { ...(payload || {}) };
}

const api = Object.freeze({
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  normalizeContextWindowTokens,
  inputBudgetForContextWindow,
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  applyContextBudget,
  applyContextBudgetToChatPayload,
  applyContextBudgetToResponsesPayload,
  applyContextBudgetToOpenAiPayload,
});

return api;
});
