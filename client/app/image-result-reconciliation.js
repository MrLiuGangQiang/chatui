(function initChatUIImageResultReconciliation(root) {
  'use strict';

  const messagePrimitives = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (typeof require === 'function' ? require('../core/message-primitives') : {});
  const { isDurableImageCompletionMessage, hasPersistedImageResult } = messagePrimitives;

  function hasValue(value) {
    return value !== undefined && value !== null && String(value) !== '';
  }

  function sameValue(left, right) {
    return hasValue(left) && hasValue(right) && String(left) === String(right);
  }

  function normalizedIndex(value) {
    if (!hasValue(value)) return -1;
    const index = Number(value);
    return Number.isFinite(index) && index >= 0 ? index : -1;
  }

  function isPending(item) {
    return item?.pending === true || item?.pending === 1 || item?.pending === '1';
  }

  function isImageCompletionMessage(message) {
    return typeof isDurableImageCompletionMessage === 'function'
      && isDurableImageCompletionMessage(message);
  }

  function isImageCompletionDisplayItem(item) {
    return item?.role === 'assistant'
      && !isPending(item)
      && typeof hasPersistedImageResult === 'function'
      && hasPersistedImageResult(item);
  }

  function createAnchor({ item = null, currentItem = null, job = null, responseIndex = -1 } = {}) {
    const anchorItem = currentItem || item;
    const displayIds = new Set([
      anchorItem?.id,
      anchorItem?.displayItemId,
      job?.displayItemId,
    ].filter(hasValue).map(String));
    const jobIds = new Set([
      anchorItem?.jobId,
      anchorItem?.imageJobId,
      job?.id,
      job?.jobId,
      job?.imageJobId,
    ].filter(hasValue).map(String));
    const responseIndexes = new Set([
      responseIndex,
      anchorItem?.responseIndex,
      job?.responseIndex,
    ].map(normalizedIndex).filter(index => index >= 0).map(String));

    return {
      displayIds,
      jobIds,
      responseIndexes,
      matches(candidate, candidateIndex = -1) {
        if (!candidate) return false;
        return (candidate.id && displayIds.has(String(candidate.id)))
          || (candidate.displayItemId && displayIds.has(String(candidate.displayItemId)))
          || (candidate.jobId && jobIds.has(String(candidate.jobId)))
          || (candidate.imageJobId && jobIds.has(String(candidate.imageJobId)))
          || (hasValue(candidate.responseIndex) && responseIndexes.has(String(candidate.responseIndex)))
          || (!hasValue(candidate.responseIndex) && candidateIndex >= 0 && responseIndexes.has(String(candidateIndex)));
      },
    };
  }

  function hasSuccessfulImageResult({ session, item = null, job = null, responseIndex = -1 } = {}) {
    if (!session) return false;
    const anchor = createAnchor({ item, job, responseIndex });
    // Only a canonical message can survive the refresh projection. A completed
    // display card is not sufficient because completed display items are pruned
    // after canonical rendering and must not authorize durable-job cleanup.
    return (session.messages || []).some((message, index) => (
      isImageCompletionMessage(message) && anchor.matches(message, index)
    ));
  }

  function reconcileSuccessfulImageResult({ session, currentItem = null, job = null, responseIndex = -1 } = {}) {
    if (!session) return { changed: false, removedDisplayItems: [], removedMessages: [] };

    const anchor = createAnchor({ currentItem, job, responseIndex });
    const currentId = currentItem?.id || '';
    const resolvedIndex = normalizedIndex(responseIndex) >= 0
      ? normalizedIndex(responseIndex)
      : normalizedIndex(currentItem?.responseIndex);
    const originalDisplay = Array.isArray(session.display) ? session.display : [];
    const successfulDisplayItem = (
      currentItem && isImageCompletionDisplayItem(currentItem) ? currentItem : null
    ) || originalDisplay.find(item => isImageCompletionDisplayItem(item) && anchor.matches(item)) || null;

    const removedDisplayItems = [];
    session.display = originalDisplay.filter(item => {
      if (!successfulDisplayItem) return true;
      if (!item || !['assistant', 'error'].includes(item.role) || !anchor.matches(item)) return true;
      const isCurrent = item === currentItem || (currentId && sameValue(item.id, currentId));
      if (isCurrent || item === successfulDisplayItem) return true;
      removedDisplayItems.push(item);
      return false;
    });

    const originalMessages = Array.isArray(session.messages) ? session.messages : [];
    const successfulMessages = originalMessages.filter((message, index) => (
      isImageCompletionMessage(message) && anchor.matches(message, index)
    ));
    const successfulMessage = successfulMessages.find(message => (
      (currentId && sameValue(message.displayItemId, currentId))
      || (job?.id && sameValue(message.imageJobId, job.id))
    )) || successfulMessages[0] || null;

    const removedMessages = [];
    session.messages = originalMessages.filter((message, index) => {
      if (!successfulMessage || !message || message === successfulMessage) return true;
      if (!['assistant', 'error'].includes(message.role) || !anchor.matches(message, index)) return true;
      removedMessages.push(message);
      return false;
    });

    return {
      changed: removedDisplayItems.length > 0 || removedMessages.length > 0,
      removedDisplayItems,
      removedMessages,
      responseIndex: resolvedIndex,
      currentDisplayItemId: currentId,
      jobId: job?.id || '',
    };
  }

  const api = Object.freeze({
    reconcileSuccessfulImageResult,
    hasSuccessfulImageResult,
    isImageCompletionMessage,
    isImageCompletionDisplayItem,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIImageResultReconciliation = api;
  if (root?.window) root.window.ChatUIImageResultReconciliation = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
