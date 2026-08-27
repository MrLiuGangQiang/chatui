(function initChatUIAppSessionConfig(root) {
  'use strict';

  function getEffectiveImageStylePrompt({ session = null, config = {} } = {}) {
    return String(session?.hasImageStylePromptOverride ? session.imageStylePrompt || '' : config.imageStylePrompt || '').trim();
  }

  function hasSessionPromptContent(session = null) {
    return !!(session?.hasSystemPromptOverride && String(session?.systemPrompt || '').trim());
  }

  function hasSessionImageStyleContent(session = null) {
    return !!(session?.hasImageStylePromptOverride && String(session?.imageStylePrompt || '').trim());
  }

  function getSessionChatModel({ session = null, config = {}, models = [] } = {}) {
    const selected = String(session?.chatModel || '').trim();
    return selected && models.includes(selected) ? selected : config.chatModel;
  }

  function getSessionRouteModel({ session = null, config = {}, models = [] } = {}) {
    const configuredRouteModel = String(config.routeModel || '').trim();
    return configuredRouteModel || getSessionChatModel({ session, config, models });
  }

  function sessionChatModelValue(session = null, models = []) {
    const selected = String(session?.chatModel || '').trim();
    return selected && models.includes(selected) ? selected : '';
  }

  function sessionModelOptions({ models = [], globalChatModel = '', isAllowed = () => true } = {}) {
    const chatModels = [...new Set(models)].filter(model => isAllowed(model, 'chat'));
    return [{ value: '', label: `跟随全局${globalChatModel ? ` · ${globalChatModel}` : ''}` }]
      .concat(chatModels.map(model => ({ value: model, label: model })));
  }

  function normalizeSessionChatModel(model = '', models = []) {
    return models.includes(model) ? model : '';
  }

  const api = Object.freeze({
    getEffectiveImageStylePrompt,
    hasSessionPromptContent,
    hasSessionImageStyleContent,
    getSessionChatModel,
    getSessionRouteModel,
    sessionChatModelValue,
    sessionModelOptions,
    normalizeSessionChatModel,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionConfig = api;
  if (root?.window) root.window.ChatUIAppSessionConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
