(function initChatUIAppDialogWorkflow(root) {
  'use strict';

  function createDialogWorkflow(deps = {}) {
    const { document, window, getElement, setTimeout, clearTimeout } = deps;
    let activeConfirmDialog = null;

    function schedule(callback, delay) {
      if (typeof setTimeout === 'function') return setTimeout(callback, delay);
      return window.setTimeout.call(window, callback, delay);
    }

    function cancelScheduled(handle) {
      if (handle == null) return;
      if (typeof clearTimeout === 'function') clearTimeout(handle);
      else window.clearTimeout.call(window, handle);
    }

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

        // Capture the caller's focus before finishing a previous dialog.  A
        // replacement must run the old cleanup path; resolving its Promise
        // alone leaves listeners and focus timers attached to the new dialog.
        const previousFocus = document.activeElement;
        activeConfirmDialog?.finish?.(false);
        const record = { resolve, previousFocus, finished: false, focusTimer: null, finish: null };
        activeConfirmDialog = record;
        if (title) title.textContent = options.title || '确认操作';
        if (message) message.textContent = options.message || '此操作不可撤销。';
        confirm.textContent = options.confirmText || '确认';
        if (cancel) cancel.textContent = options.cancelText || '取消';
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
        document.body.classList.add('confirm-open');

        const finish = value => {
          if (record.finished) return;
          record.finished = true;
          cancelScheduled(record.focusTimer);
          dialog.querySelectorAll('[data-confirm-cancel]').forEach(item => item.removeEventListener('click', onCancel));
          confirm.removeEventListener('click', onConfirm);
          document.removeEventListener('keydown', onKeydown);
          // A stale listener can run after another dialog has been opened.
          // It may settle its own Promise, but must never hide or focus the
          // currently active dialog.
          if (activeConfirmDialog === record) {
            dialog.classList.remove('show');
            dialog.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('confirm-open');
            activeConfirmDialog = null;
            record.previousFocus?.focus?.();
          }
          resolve(value);
        };
        record.finish = finish;
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onKeydown = event => { if (event.key === 'Escape') finish(false); };

        dialog.querySelectorAll('[data-confirm-cancel]').forEach(item => item.addEventListener('click', onCancel));
        confirm.addEventListener('click', onConfirm);
        document.addEventListener('keydown', onKeydown);
        record.focusTimer = schedule(() => {
          if (activeConfirmDialog === record && !record.finished) confirm.focus();
        }, 30);
      });
    }

    return Object.freeze({ toast, showConfirmDialog });
  }

  const api = Object.freeze({ createDialogWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppDialogWorkflow = api;
  if (root?.window) root.window.ChatUIAppDialogWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
