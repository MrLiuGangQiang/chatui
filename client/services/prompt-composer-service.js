(function initChatUIPromptComposerService(root) {
  'use strict';

  const MAX_EXECUTION_PROMPT_LENGTH = 3200;

  // The task contract chooses the operation and source media. It must never rewrite the user's
  // request into internal routing or patch language before that request reaches the model.
  function composeExecutionPrompt(input = '') {
    const text = String(input || '').trim();
    return text.length > MAX_EXECUTION_PROMPT_LENGTH
      ? `${text.slice(0, MAX_EXECUTION_PROMPT_LENGTH)}…`
      : text;
  }

  const api = Object.freeze({ composeExecutionPrompt });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIPromptComposerService = api;
  if (root?.window) root.window.ChatUIPromptComposerService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
