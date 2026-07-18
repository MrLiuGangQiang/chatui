(function initChatUIAppContext(root) {
  'use strict';

  function resolveRuntimeDependencies(rootLike = root) {
    const runtimeHelpers = rootLike?.ChatUIApp?.runtime || {};
    const doneSound = typeof runtimeHelpers.createDoneSound === 'function'
      ? runtimeHelpers.createDoneSound()
      : null;
    return { runtimeHelpers, doneSound };
  }

  function defineLazyWorkflowGetter(target, name, factory, options = {}) {
    if (!target || !name || typeof factory !== 'function') throw new Error('defineLazyWorkflowGetter requires target, name, and factory');
    const cacheKey = options.cacheKey || `__${String(name)}Instance`;
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get() {
        if (!Object.prototype.hasOwnProperty.call(target, cacheKey)) target[cacheKey] = factory();
        return target[cacheKey];
      },
    });
    return target;
  }

  const workflowModules = new Map();

  function registerWorkflowModule(name, moduleApi) {
    const key = String(name || '').trim();
    if (!key || !moduleApi) throw new Error('registerWorkflowModule requires name and module API');
    workflowModules.set(key, moduleApi);
    return moduleApi;
  }

  function getWorkflowModule(name) {
    return workflowModules.get(String(name || '').trim()) || null;
  }

  function createWorkflowRegistry(factories = {}) {
    const cache = new Map();
    return Object.freeze({
      get(name) {
        if (!Object.prototype.hasOwnProperty.call(factories, name)) throw new Error(`Workflow ${name} is not registered`);
        if (!cache.has(name)) cache.set(name, factories[name]());
        return cache.get(name);
      },
      has(name) {
        return Object.prototype.hasOwnProperty.call(factories, name);
      },
    });
  }

  const api = Object.freeze({ resolveRuntimeDependencies, defineLazyWorkflowGetter, createWorkflowRegistry, registerWorkflowModule, getWorkflowModule });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIApp = Object.freeze({ ...(root.ChatUIApp || {}), appContext: api });
  if (root?.window) root.window.ChatUIApp = root.ChatUIApp;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
