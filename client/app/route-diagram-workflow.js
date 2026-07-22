(function initChatUIRouteDiagramWorkflow(root) {
  'use strict';

  function createRouteDiagramWorkflow(deps = {}) {
    const documentRef = deps.document || root?.document;
    const routeUrl = deps.routeUrl || './route.html?v=1.3.2-stage3-centered';
    let initialized = false;
    let lastFocused = null;

    function elements() {
      return {
        trigger: documentRef?.getElementById('routeDiagramFab'),
        modal: documentRef?.getElementById('routeDiagramModal'),
        frame: documentRef?.getElementById('routeDiagramFrame'),
        close: documentRef?.getElementById('closeRouteDiagramBtn'),
      };
    }

    function isOpen() {
      return elements().modal?.classList.contains('show') || false;
    }

    function open() {
      const { trigger, modal, frame, close } = elements();
      if (!trigger || !modal || !frame) return false;
      lastFocused = documentRef.activeElement === trigger ? trigger : documentRef.activeElement;
      if (!frame.getAttribute('src')) frame.setAttribute('src', routeUrl);
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
      close?.focus?.();
      return true;
    }

    function close() {
      const { trigger, modal } = elements();
      if (!trigger || !modal || !isOpen()) return false;
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
      (lastFocused?.focus || trigger.focus)?.call(lastFocused?.focus ? lastFocused : trigger);
      lastFocused = null;
      return true;
    }

    function init() {
      if (initialized || !documentRef) return;
      const { trigger, modal } = elements();
      if (!trigger || !modal) return;
      initialized = true;
      trigger.addEventListener('click', open);
      modal.querySelectorAll('[data-route-diagram-close]').forEach(node => node.addEventListener('click', close));
      documentRef.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) {
          event.preventDefault();
          close();
        }
      });
    }

    return Object.freeze({ init, open, close, isOpen });
  }

  const api = Object.freeze({ createRouteDiagramWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIRouteDiagramWorkflow = api;
  if (root?.window) root.window.ChatUIRouteDiagramWorkflow = api;
  if (root?.document) {
    const controller = createRouteDiagramWorkflow();
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => controller.init(), { once: true });
    else controller.init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
