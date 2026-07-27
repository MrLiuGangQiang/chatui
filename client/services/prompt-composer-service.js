(function initChatUIPromptComposerService(root) {
  'use strict';

  const preflightGuards = root?.ChatUICorePreflightGuards
    || root?.window?.ChatUICorePreflightGuards
    || (typeof require === 'function' ? require('../core/preflight-guards') : {});

  // The task contract chooses the operation and source media. It must never rewrite the user's
  // request into internal routing or patch language before that request reaches the model.
  function composeExecutionPrompt(input = '') {
    const text = String(input || '').trim();
    const validation = preflightGuards?.validateMessageSize?.(text);
    if (validation && !validation.ok) {
      const error = new RangeError(validation.message || 'Message exceeds the configured input limit');
      error.code = validation.code || 'message_too_many_characters';
      error.length = validation.length;
      error.maxChars = validation.maxChars;
      throw error;
    }
    return text;
  }

  const api = Object.freeze({ composeExecutionPrompt });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIPromptComposerService = api;
  if (root?.window) root.window.ChatUIPromptComposerService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
