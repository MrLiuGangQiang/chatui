(function initChatUIAppComposerLayoutWorkflow(root) {
  'use strict';

  const LARGE_PROMPT_LAYOUT_THRESHOLD = 20000;

  function createComposerLayoutWorkflow(deps = {}) {
    const { getElement, window, document, requestAnimationFrame } = deps;
    let resizeFrame = 0;
    let resizeSecondFrame = 0;

    function updateComposerSafeArea() {
      const composer = getElement('composer');
      const messages = getElement('messages');
      if (!composer || !messages) return;
      const rect = composer.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
      const safeBottom = Math.ceil(Math.max(120, viewportHeight - rect.top + 28));
      document.documentElement.style.setProperty('--composer-safe-bottom', `${safeBottom}px`);
      messages.style.scrollPaddingBottom = `${safeBottom}px`;
    }

    function autoResize() {
      const prompt = getElement('prompt');
      if (!prompt) return false;
      const mobile = window.matchMedia('(max-width: 640px)').matches;
      const maxHeight = Math.round(window.innerHeight * (mobile ? 0.36 : 0.42));
      const minHeight = mobile ? 42 : 52;
      const previousHeight = prompt.style.getPropertyValue('--prompt-height');
      const previousOverflow = prompt.style.overflowY;

      if (String(prompt.value || '').length > LARGE_PROMPT_LAYOUT_THRESHOLD) {
        prompt.style.setProperty('--prompt-height', `${maxHeight}px`);
        prompt.style.setProperty('height', `${maxHeight}px`, 'important');
        prompt.style.overflowY = 'auto';
        updateComposerSafeArea();
        return previousHeight !== `${maxHeight}px` || previousOverflow !== 'auto';
      }

      prompt.style.setProperty('--prompt-height', `${minHeight}px`);
      prompt.style.setProperty('height', `${minHeight}px`, 'important');
      const contentHeight = prompt.scrollHeight;
      const height = Math.max(minHeight, Math.min(contentHeight, maxHeight));
      const overflow = contentHeight > maxHeight ? 'auto' : 'hidden';
      prompt.style.setProperty('--prompt-height', `${height}px`);
      prompt.style.setProperty('height', `${height}px`, 'important');
      prompt.style.overflowY = overflow;
      updateComposerSafeArea();
      return previousHeight !== `${height}px` || previousOverflow !== overflow;
    }

    function scheduleAutoResize() {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (!autoResize()) return;
        if (resizeSecondFrame) window.cancelAnimationFrame?.(resizeSecondFrame);
        resizeSecondFrame = requestAnimationFrame(() => {
          resizeSecondFrame = 0;
          autoResize();
        });
      });
    }

    return Object.freeze({ updateComposerSafeArea, autoResize, scheduleAutoResize });
  }

  const api = Object.freeze({ LARGE_PROMPT_LAYOUT_THRESHOLD, createComposerLayoutWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppComposerLayoutWorkflow = api;
  if (root?.window) root.window.ChatUIAppComposerLayoutWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
