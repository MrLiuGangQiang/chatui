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
  return `display_${now().toString(36).slice(-6)}${random().toString(36).slice(2, 6)}`;
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

function normalizeCanonicalNodeRole(role = '') {
  return role === 'error' ? 'assistant' : role;
}

function setMessageNodeIndex(node, role, index) {
  if (!node?.dataset || !Number.isFinite(index)) return node || null;
  const normalizedRole = normalizeCanonicalNodeRole(role || messageNodeRole(node));
  const key = normalizedRole === 'user' ? 'messageIndex' : normalizedRole === 'assistant' ? 'responseIndex' : '';
  if (!key) return node;
  const otherKey = key === 'messageIndex' ? 'responseIndex' : 'messageIndex';
  const value = String(index);
  // Rewriting an unchanged dataset value emits an attribute mutation in real
  // browsers. During a stream that wakes the list-level layout observer even
  // though neither this message nor its canonical position has changed.
  if (node.dataset[key] !== value) node.dataset[key] = value;
  if (Object.prototype.hasOwnProperty.call(node.dataset, otherKey)) delete node.dataset[otherKey];
  if (node.__displayItem) {
    node.__displayItem[key] = value;
    delete node.__displayItem[otherKey];
  }
  return node;
}

function shiftCanonicalSuffixForInsertion(nodes, node, expectedRole, expectedIndex) {
  const indexed = nodes.map((candidate, domIndex) => {
    const role = normalizeCanonicalNodeRole(messageNodeRole(candidate));
    return { candidate, domIndex, role, index: messageNodeIndex(candidate, role) };
  }).filter(entry => entry.candidate !== node && entry.role && Number.isFinite(entry.index));
  const hasCrossRoleCollision = indexed.some(entry => entry.role !== expectedRole && entry.index === expectedIndex);
  if (!hasCrossRoleCollision) return false;

  // A canonical insertion reindexes every later record. The live DOM may still
  // expose the old suffix indexes, so comparing only `> expectedIndex` moves the
  // inserted image/reply below the next user turn until a refresh rebuilds it.
  // The opposite-role collision at the inserted slot is the unambiguous signal
  // that this suffix still needs the same one-position shift as canonical state.
  indexed
    .filter(entry => entry.index >= expectedIndex)
    .sort((left, right) => right.index - left.index || right.domIndex - left.domIndex)
    .forEach(entry => setMessageNodeIndex(entry.candidate, entry.role, entry.index + 1));
  return true;
}

function reconcileCanonicalMessageNode(container, node, { role = '', index = null } = {}) {
  if (!container?.querySelectorAll || !node) return node || null;
  const expectedRole = normalizeCanonicalNodeRole(role || messageNodeRole(node));
  const expectedIndex = parseDisplayMessageIndex(index);
  if (!expectedRole || !Number.isFinite(expectedIndex)) return node;
  setMessageNodeIndex(node, expectedRole, expectedIndex);
  const nodes = [...container.querySelectorAll('.message')];
  for (const candidate of nodes) {
    const candidateRole = normalizeCanonicalNodeRole(messageNodeRole(candidate));
    if (candidate === node || candidateRole !== expectedRole) continue;
    if (messageNodeIndex(candidate, candidateRole) === expectedIndex) candidate.remove();
  }
  const remainingNodes = [...container.querySelectorAll('.message')];
  shiftCanonicalSuffixForInsertion(remainingNodes, node, expectedRole, expectedIndex);
  const anchor = [...container.querySelectorAll('.message')].find(candidate => {
    if (candidate === node) return false;
    const candidateRole = normalizeCanonicalNodeRole(messageNodeRole(candidate));
    const candidateIndex = messageNodeIndex(candidate, candidateRole);
    return Number.isFinite(candidateIndex) && candidateIndex > expectedIndex;
  });
  if (anchor?.parentNode === container) {
    // insertBefore(node, node.nextElementSibling) still removes and reinserts
    // `node`. Repeating that for each stream chunk invalidates every sibling
    // below the response and is the source of the visible history flicker.
    if (node.parentNode !== container || node.nextElementSibling !== anchor) container.insertBefore(node, anchor);
  } else if (node.parentNode !== container || node !== container.lastElementChild) container.appendChild(node);
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
