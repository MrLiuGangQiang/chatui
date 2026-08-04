(function initChatUIModuleRegistry(root) {
  'use strict';

  const REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');
  let modules = root?.[REGISTRY_SYMBOL];
  if (!(modules instanceof Map)) {
    modules = new Map();
    Object.defineProperty(root, REGISTRY_SYMBOL, {
      value: modules,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }

  function normalizeName(name = '') {
    const key = String(name || '').trim();
    if (!key) throw new TypeError('module registry name is required');
    return key;
  }

  function register(name, moduleApi) {
    const key = normalizeName(name);
    if (!moduleApi || typeof moduleApi !== 'object') throw new TypeError(`module registry api is required: ${key}`);
    const current = modules.get(key);
    if (current && current !== moduleApi) throw new Error(`module registry entry already exists: ${key}`);
    modules.set(key, moduleApi);
    return moduleApi;
  }

  function resolve(name) {
    return modules.get(normalizeName(name)) || null;
  }

  const api = Object.freeze({ REGISTRY_SYMBOL, register, resolve });
  modules.set('moduleRegistry', api);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
