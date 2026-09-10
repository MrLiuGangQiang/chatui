(function initChatUIModelRecommendation(root, factory) {
  'use strict';

  const shared = root?.[Symbol.for('chatui.module-registry.v1')]?.get('modelRecommendationConfig')
    || (typeof require === 'function' ? require('../../shared/model-recommendation') : {});
  const api = factory(shared, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('modelRecommendationUi', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIModelRecommendationUi(shared, root) {
  'use strict';

  const normalizeModelRecommendation = shared.normalizeModelRecommendation || (value => value);
  const formatWelcomeModelNote = shared.formatWelcomeModelNote || (() => '');
  const DEFAULT_MODEL_RECOMMENDATION = shared.DEFAULT_MODEL_RECOMMENDATION || Object.freeze({});
  let currentRecommendation = DEFAULT_MODEL_RECOMMENDATION;
  let observer = null;
  let observedDocument = null;

  function observeMessages(documentRef) {
    if (observer || !documentRef || typeof root?.MutationObserver !== 'function') return;
    const target = documentRef.getElementById?.('messages') || documentRef.body;
    if (!target) return;
    observedDocument = documentRef;
    observer = new root.MutationObserver(() => renderModelRecommendation(observedDocument));
    observer.observe(target, { childList: true, subtree: true });
  }

  function renderModelRecommendation(documentRef, recommendation) {
    if (recommendation !== undefined) currentRecommendation = normalizeModelRecommendation(recommendation);
    const current = currentRecommendation;
    documentRef?.querySelectorAll?.('[data-model-recommendation]')?.forEach(node => {
      const field = String(node.getAttribute('data-model-recommendation') || '').trim();
      const value = String(current?.[field] || '').trim();
      if (value && node.textContent !== value) node.textContent = value;
    });
    const welcomeNote = documentRef?.querySelector?.('.welcome-model-note');
    const welcomeText = formatWelcomeModelNote(current);
    if (welcomeNote && welcomeText && welcomeNote.textContent !== welcomeText) welcomeNote.textContent = welcomeText;
    observeMessages(documentRef);
    return current;
  }

  function registerWithAppContext(rootRef = root, apiRef = null) {
    const appContext = rootRef?.ChatUIApp?.appContext;
    const moduleApi = apiRef || { applyModelRecommendation: renderModelRecommendation, renderModelRecommendation };
    if (typeof appContext?.registerWorkflowModule !== 'function') return false;
    appContext.registerWorkflowModule('modelRecommendationUi', moduleApi);
    return true;
  }

  const api = Object.freeze({
    applyModelRecommendation: renderModelRecommendation,
    renderModelRecommendation,
    getCurrentModelRecommendation: () => currentRecommendation,
    registerWithAppContext,
  });
  registerWithAppContext(root, api);
  return api;
});
