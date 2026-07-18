(function initChatUICoreBrowser(global) {
  'use strict';

  const http = global.ChatUICoreHttp || {};
  const reasoning = global.ChatUICoreReasoning || {};
  const sharedModels = global.ChatUICoreModels || {};
  const imageReferences = global.ChatUICoreImageReferences || {};
  const imageRouteContext = global.ChatUICoreImageRouteContext || {};
  const attachments = global.ChatUICoreAttachments || {};
  const contextBudget = global.ChatUICoreContextBudget || {};
  const storage = global.ChatUICoreStorage || {};
  const registeredModules = new Map();

  function registerModule(name, moduleApi) {
    const key = String(name || '').trim();
    if (!key || !moduleApi || typeof moduleApi !== 'object') throw new Error('core module name and api are required');
    if (registeredModules.has(key)) throw new Error(`core module already registered: ${key}`);
    registeredModules.set(key, Object.freeze(moduleApi));
    return registeredModules.get(key);
  }

  function browserExtractModels(payload) {
    const list = typeof sharedModels.extractModels === 'function' ? sharedModels.extractModels(payload) : [];
    const meta = {};
    const models = [];
    (Array.isArray(list) ? list : []).forEach(item => {
      const id = typeof item === 'string' ? item : item?.id || item?.name;
      if (!id) return;
      const modelId = String(id);
      const type = typeof sharedModels.inferModelType === 'function' ? sharedModels.inferModelType(item) : item?.type || '';
      meta[modelId] = { id: modelId, type, unrecognized: !type, inferred: !item?.type && !!type };
      models.push(modelId);
    });
    return { models: Array.from(new Set(models)).sort(), meta };
  }

  function browserIsModelAllowedFor(modelId, targetType, meta = {}) {
    const rawType = meta?.[modelId]?.type || '';
    const type = typeof sharedModels.normalizeModelType === 'function' ? sharedModels.normalizeModelType(rawType) : rawType;
    if (!type) return true;
    return targetType === 'image' ? type === 'image' : targetType !== 'chat' || type !== 'image';
  }

  const models = Object.freeze({
    normalizeModelType: sharedModels.normalizeModelType,
    inferModelType: sharedModels.inferModelType,
    normalizeModelMeta: sharedModels.normalizeModelMeta,
    extractModels: browserExtractModels,
    isModelAllowedFor: browserIsModelAllowedFor,
  });

  const api = {
    http: Object.freeze(http),
    reasoning: Object.freeze(reasoning),
    models,
    imageReferences: Object.freeze(imageReferences),
    imageRouteContext: Object.freeze(imageRouteContext),
    attachments: Object.freeze(attachments),
    contextBudget: Object.freeze(contextBudget),
    storage: Object.freeze(storage),
    registerModule,
  };
  Object.defineProperty(api, 'taskState', {
    enumerable: true,
    get: () => registeredModules.get('taskState') || null,
  });
  Object.freeze(api);
  if (typeof window !== 'undefined') window.ChatUICore = api;
  else global.ChatUICore = api;
})(typeof window !== 'undefined' ? window : globalThis);
