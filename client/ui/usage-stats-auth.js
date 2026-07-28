(() => {
  const CONFIG_KEY = 'openapi-chat-image-config-v2';
  const API_KEY_SESSION_KEY = `${CONFIG_KEY}:api-key`;
  const DEPARTMENT_PASSWORD_KEY = 'openapi-chat-usage-department-password';
  let memoryDepartmentPassword = '';

  function safeGlobalStorage(name) {
    try { return globalThis[name] || null; } catch { return null; }
  }

  function normalizeBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function currentApiKey({ getElement = id => document.getElementById(id), storage } = {}) {
    const inputValue = getElement('apiKey')?.value?.trim();
    if (inputValue) return inputValue;
    try {
      const target = storage || globalThis.sessionStorage;
      return String(target?.getItem(API_KEY_SESSION_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function shouldLoadRanking(apiKey) {
    return Boolean(String(apiKey || '').trim());
  }

  function currentBaseUrl({ getElement = id => document.getElementById(id) } = {}) {
    return normalizeBaseUrl(getElement('baseUrl')?.value);
  }

  function getDepartmentPassword(storage = safeGlobalStorage('sessionStorage'), legacyStorage = safeGlobalStorage('localStorage')) {
    try {
      const current = String(storage?.getItem(DEPARTMENT_PASSWORD_KEY) || '').trim();
      if (current) memoryDepartmentPassword = current;
    } catch {}
    if (memoryDepartmentPassword) return memoryDepartmentPassword;
    try {
      const legacy = String(legacyStorage?.getItem(DEPARTMENT_PASSWORD_KEY) || '').trim();
      if (!legacy) return '';
      memoryDepartmentPassword = legacy;
      try { storage?.setItem(DEPARTMENT_PASSWORD_KEY, legacy); } catch {}
      try { legacyStorage?.removeItem(DEPARTMENT_PASSWORD_KEY); } catch {}
      return legacy;
    } catch {
      return memoryDepartmentPassword;
    }
  }

  function setDepartmentPassword(password, storage = safeGlobalStorage('sessionStorage'), legacyStorage = safeGlobalStorage('localStorage')) {
    memoryDepartmentPassword = String(password || '').trim();
    try {
      if (memoryDepartmentPassword) storage?.setItem(DEPARTMENT_PASSWORD_KEY, memoryDepartmentPassword);
      else storage?.removeItem(DEPARTMENT_PASSWORD_KEY);
    } catch {}
    try { legacyStorage?.removeItem(DEPARTMENT_PASSWORD_KEY); } catch {}
  }

  function clearDepartmentPassword(storage = safeGlobalStorage('sessionStorage'), legacyStorage = safeGlobalStorage('localStorage')) {
    memoryDepartmentPassword = '';
    try { storage?.removeItem(DEPARTMENT_PASSWORD_KEY); } catch {}
    try { legacyStorage?.removeItem(DEPARTMENT_PASSWORD_KEY); } catch {}
  }

  const api = {
    CONFIG_KEY,
    API_KEY_SESSION_KEY,
    DEPARTMENT_PASSWORD_KEY,
    normalizeBaseUrl,
    currentApiKey,
    currentBaseUrl,
    shouldLoadRanking,
    getDepartmentPassword,
    setDepartmentPassword,
    clearDepartmentPassword,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ChatUIUsageStatsAuth = api;
})();
