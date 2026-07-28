(function (root) {
function compactDisplayItems(items = []) {
  const result = [];
  for (const item of items || []) {
    if (!item) continue;
    const prev = result[result.length - 1];
    const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || '', item.quoteContext || ''].join('');
    const prevKey = prev ? [prev.role || '', prev.rawText || '', prev.html || '', prev.pending || '', prev.jobId || '', prev.responseIndex || '', prev.messageIndex || '', prev.quoteContext || ''].join('') : '';
    if (prev && key === prevKey) {
      if (item.metaText && !prev.metaText) prev.metaText = item.metaText;
      if (item.reasoningText && !prev.reasoningText) prev.reasoningText = item.reasoningText;
      if (item.keepReasoning && !prev.keepReasoning) prev.keepReasoning = item.keepReasoning;
      if (item.quoteContext && !prev.quoteContext) prev.quoteContext = item.quoteContext;
      if (item.imageContext && !prev.imageContext) prev.imageContext = item.imageContext;
      if (item.attachmentContext && !prev.attachmentContext) prev.attachmentContext = item.attachmentContext;
    } else {
      result.push(item);
    }
  }
  return result;
}

function makeDisplayItemId(now = Date.now, random = Math.random) {
  return `display_${now().toString(36)}_${random().toString(36).slice(2, 9)}`;
}

function displayItemHasRichMedia(item) {
  return !!(item?.html && (
    /data-persisted-src=/.test(item.html) ||
    /data-persisted-href=/.test(item.html) ||
    /user-attachment-preview-grid/.test(item.html) ||
    /class=["'][^"']*generated-thumb/.test(item.html) ||
    /class=["'][^"']*user-attachment-image/.test(item.html) ||
    /image-download-row/.test(item.html) ||
    /sent-quote-preview/.test(item.html)
  ));
}

function parseDisplayMessageIndex(value) {
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return NaN;
  const index = Number(value);
  return Number.isFinite(index) && index >= 0 ? index : NaN;
}

function canonicalMessageIndex(message, fallbackIndex = -1) {
  const raw = message?.role === 'user' ? message?.messageIndex : message?.role === 'assistant' ? message?.responseIndex : undefined;
  const index = parseDisplayMessageIndex(raw);
  return Number.isFinite(index) ? index : Number(fallbackIndex);
}

function canonicalMessageNodeRole(message) {
  if (message?.role === 'assistant') return 'assistant';
  if (message?.role === 'error') return 'error';
  return 'user';
}

function messageNodeRole(node) {
  if (node?.classList?.contains?.('user')) return 'user';
  if (node?.classList?.contains?.('assistant')) return 'assistant';
  if (node?.classList?.contains?.('error')) return 'error';
  return '';
}

function messageNodeIndex(node, role = messageNodeRole(node)) {
  const raw = role === 'user' ? node?.dataset?.messageIndex : role === 'assistant' ? node?.dataset?.responseIndex : '';
  return parseDisplayMessageIndex(raw);
}

function reconcileCanonicalMessageNode(container, node, { role = '', index = null } = {}) {
  if (!container?.querySelectorAll || !node) return node || null;
  const normalizeRole = value => value === 'error' ? 'assistant' : value;
  const expectedRole = normalizeRole(role || messageNodeRole(node));
  const expectedIndex = parseDisplayMessageIndex(index);
  if (!expectedRole || !Number.isFinite(expectedIndex)) return node;
  const nodes = [...container.querySelectorAll('.message')];
  for (const candidate of nodes) {
    const candidateRole = normalizeRole(messageNodeRole(candidate));
    if (candidate === node || candidateRole !== expectedRole) continue;
    if (messageNodeIndex(candidate, candidateRole) === expectedIndex) candidate.remove();
  }
  const anchor = [...container.querySelectorAll('.message')].find(candidate => {
    if (candidate === node) return false;
    const candidateRole = normalizeRole(messageNodeRole(candidate));
    const candidateIndex = messageNodeIndex(candidate, candidateRole);
    return Number.isFinite(candidateIndex) && candidateIndex > expectedIndex;
  });
  if (anchor?.parentNode === container) container.insertBefore(node, anchor);
  else if (node.parentNode !== container || node !== container.lastElementChild) container.appendChild(node);
  return node;
}

function insertMessageNodeAtDisplayPosition(container, node, item = {}) {
  const role = item?.role || messageNodeRole(node);
  const index = role === 'user' ? item?.messageIndex : item?.responseIndex;
  return reconcileCanonicalMessageNode(container, node, { role, index });
}

function isPendingMessageNode(node) {
  return node?.__displayItem?.pending === '1'
    || node?.dataset?.pending === '1'
    || node?.dataset?.pendingFeedback === '1'
    || (!!node?.dataset?.jobId && node?.dataset?.streaming === '1')
    || !!node?.querySelector?.('.pending-feedback');
}

function canonicalMessageNodeMatches(node, message, fallbackIndex = -1) {
  if (!node || !message || messageNodeRole(node) !== canonicalMessageNodeRole(message) || isPendingMessageNode(node)) return false;
  const expectedIndex = canonicalMessageIndex(message, fallbackIndex);
  const actualIndex = messageNodeIndex(node, canonicalMessageNodeRole(message));
  if (Number.isFinite(expectedIndex) && Number.isFinite(actualIndex) && actualIndex !== expectedIndex) return false;
  const expectedText = String(message.rawText ?? message.content ?? '');
  if (!expectedText) return true;
  const actualText = String(node.dataset?.rawText || node.innerText || node.textContent || '');
  return actualText === expectedText || actualText.includes(expectedText.slice(0, 80));
}

function findCanonicalMessageNode(nodes = [], message, fallbackIndex = -1) {
  const list = Array.from(nodes || []);
  const expectedIndex = canonicalMessageIndex(message, fallbackIndex);
  if (Number.isFinite(expectedIndex)) {
    const expectedRole = canonicalMessageNodeRole(message);
    const indexed = list.find(node => messageNodeRole(node) === expectedRole && messageNodeIndex(node, expectedRole) === expectedIndex && !isPendingMessageNode(node));
    if (indexed) return canonicalMessageNodeMatches(indexed, message, fallbackIndex) ? indexed : null;
  }
  return [...list].reverse().find(node => canonicalMessageNodeMatches(node, message, fallbackIndex)) || null;
}

const displayItemsApi = Object.freeze({ compactDisplayItems, parseDisplayMessageIndex, reconcileCanonicalMessageNode, insertMessageNodeAtDisplayPosition, makeDisplayItemId, displayItemHasRichMedia, canonicalMessageIndex, canonicalMessageNodeRole, messageNodeRole, messageNodeIndex, isPendingMessageNode, canonicalMessageNodeMatches, findCanonicalMessageNode });
if (typeof module !== 'undefined' && module.exports) module.exports = displayItemsApi;
if (root) root.ChatUIAppDisplayItems = displayItemsApi;
if (root?.window) root.window.ChatUIAppDisplayItems = displayItemsApi;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
