(function initChatUIMarkdownBrowserEnhancer(global) {
  'use strict';

  const root = global.globalThis || global;
  const browser = root.window || global.window || global;
  const shared = browser.ChatUIMarkdownEnhancer || root.ChatUIMarkdownEnhancer || {};

  const api = Object.freeze({
    ...shared,
    loadMermaid: shared.defaultLoadMermaid || shared.loadMermaid,
    isVisible: shared.isElementVisible || shared.isVisible,
  });

  browser.ChatUIMarkdownBrowserEnhancer = api; // stable browser namespace: window.ChatUIMarkdownBrowserEnhancer
})(typeof window !== 'undefined' ? window : globalThis);
