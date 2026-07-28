(function initChatUIAppDialogWorkflow(root) {
  'use strict';

  function createDialogWorkflow(deps = {}) {
    const { document, window, getElement, setTimeout, clearTimeout } = deps;
    let activeConfirmDialog = null;

    function toast(message) {
      let node = document.querySelector('.toast-popup');
      if (!node) {
        node = document.createElement('div');
        node.className = 'toast-popup';
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        document.body.appendChild(node);
      }
      node.textContent = message;
      node.classList.add('show');
      window.clearTimeout.call(window, node._timer);
      node._timer = window.setTimeout.call(window, () => node.classList.remove('show'), 1800);
    }

    function showConfirmDialog(options = {}) {
      return new Promise(resolve => {
        const dialog = getElement('confirmDialog');
        const title = getElement('confirmDialogTitle');
        const message = getElement('confirmDialogMessage');
        const confirm = getElement('confirmDialogConfirm');
        const cancel = getElement('confirmDialogCancel');
        if (!dialog || !confirm) return resolve(!!window.confirm(options.message || options.title || '确认操作？'));

        activeConfirmDialog?.resolve?.(false);
        activeConfirmDialog = { resolve, previousFocus: document.activeElement };
        if (title) title.textContent = options.title || '确认操作';
        if (message) message.textContent = options.message || '此操作不可撤销。';
        confirm.textContent = options.confirmText || '确认';
        if (cancel) cancel.textContent = options.cancelText || '取消';
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
        document.body.classList.add('confirm-open');

        const finish = value => {
          dialog.classList.remove('show');
          dialog.setAttribute('aria-hidden', 'true');
          document.body.classList.remove('confirm-open');
          dialog.querySelectorAll('[data-confirm-cancel]').forEach(item => item.removeEventListener('click', onCancel));
          confirm.removeEventListener('click', onConfirm);
          document.removeEventListener('keydown', onKeydown);
          const previousFocus = activeConfirmDialog?.previousFocus;
          activeConfirmDialog = null;
          previousFocus?.focus?.();
          resolve(value);
        };
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onKeydown = event => { if (event.key === 'Escape') finish(false); };

        dialog.querySelectorAll('[data-confirm-cancel]').forEach(item => item.addEventListener('click', onCancel));
        confirm.addEventListener('click', onConfirm);
        document.addEventListener('keydown', onKeydown);
        window.setTimeout.call(window, () => confirm.focus(), 30);
      });
    }

    return Object.freeze({ toast, showConfirmDialog });
  }

  const api = Object.freeze({ createDialogWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppDialogWorkflow = api;
  if (root?.window) root.window.ChatUIAppDialogWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
