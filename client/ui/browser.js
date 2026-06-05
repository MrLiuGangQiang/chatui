(function initChatUIBrowser(global) {
  'use strict';

  const root = global.globalThis || global;
  const browser = root.window || global.window || global;

  const fileActions = browser.ChatUIFileActions || root.ChatUIFileActions || {};
  const realtime = browser.ChatUIRealtimeRenderer || root.ChatUIRealtimeRenderer || {};
  const scroll = browser.ChatUIScrollController || root.ChatUIScrollController || {};
  const messages = browser.ChatUIMessageRenderer || root.ChatUIMessageRenderer || {};
  const actions = browser.ChatUIMessageActions || root.ChatUIMessageActions || {};
  const imageActions = browser.ChatUIImageActions || root.ChatUIImageActions || {};

  browser.ChatUI = Object.freeze({ // stable browser namespace: window.ChatUI
    ...(browser.ChatUI || {}),
    fileActions: Object.freeze(fileActions),
    realtime: Object.freeze(realtime),
    scroll: Object.freeze(scroll),
    messages: Object.freeze(messages),
    actions: Object.freeze(actions),
    imageActions: Object.freeze(imageActions),
  });
})(typeof window !== 'undefined' ? window : globalThis);
