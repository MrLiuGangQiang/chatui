(function initChatUIWebPreview(root) {
  'use strict';

  let defaultController = null;

  function resolveCore(deps = {}) {
    if (deps.core?.extractWebPreviewCandidates) return deps.core;
    if (root?.ChatUICoreWebPreview?.extractWebPreviewCandidates) return root.ChatUICoreWebPreview;
    try { return require('../core/web-preview'); } catch { return {}; }
  }

  function createWebPreviewController(deps = {}) {
    const documentRef = deps.document || root?.document;
    const core = resolveCore(deps);
    if (!documentRef || typeof core.extractWebPreviewCandidates !== 'function') {
      return Object.freeze({ syncMessagePreviews: () => 0, openPreview: () => false, closePreview: () => false, downloadPreview: () => false });
    }

    function getElement(id) { return documentRef.getElementById(id); }

    function previewFilename(candidate) {
      let name = String(candidate?.title || '')
        .replace(/[\\/:*?\"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\.html?$/i, '')
        .replace(/[. ]+$/g, '');
      if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = 'web-preview';
      return `${name.slice(0, 100) || 'web-preview'}.html`;
    }

    function downloadPreview(candidate) {
      const BlobRef = deps.Blob || documentRef.defaultView?.Blob || root?.Blob;
      const URLRef = deps.URL || documentRef.defaultView?.URL || root?.URL;
      const schedule = deps.setTimeout || root?.setTimeout || setTimeout;
      if (!candidate?.source || typeof core.buildPreviewDocument !== 'function'
        || typeof BlobRef !== 'function' || typeof URLRef?.createObjectURL !== 'function') return false;
      const blob = new BlobRef([core.buildPreviewDocument(candidate.source)], { type: 'text/html;charset=utf-8' });
      const objectUrl = URLRef.createObjectURL(blob);
      const link = documentRef.createElement('a');
      link.href = objectUrl;
      link.download = previewFilename(candidate);
      link.hidden = true;
      documentRef.body?.append(link);
      link.click();
      link.remove();
      schedule(() => URLRef.revokeObjectURL?.(objectUrl), 0);
      return true;
    }

    function previewWindowDocument(candidate) {
      const title = String(candidate?.title || '网页预览');
      const source = core.buildPreviewDocument(candidate?.source || '');
      // Serialize into a script literal rather than an HTML attribute so arbitrary page markup
      // cannot break the preview shell. The page itself remains inside a sandboxed iframe.
      const serialize = value => JSON.stringify(String(value || ''))
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</title><style>html,body{width:100%;height:100%;margin:0;background:#0f172a}iframe{display:block;width:100%;height:100%;border:0;background:#fff}</style></head><body><iframe id="preview" title="网页预览内容" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation" referrerpolicy="no-referrer"></iframe><script>document.getElementById('preview').srcdoc=${serialize(source)};</script></body></html>`;
    }

    function openPreviewInNewWindow(candidate) {
      const openWindow = deps.openWindow || documentRef.defaultView?.open || root?.open;
      if (!candidate?.source || typeof openWindow !== 'function') return false;
      // This call stays in the click handler, otherwise browsers will classify it as a popup.
      const previewWindow = openWindow('', '_blank', 'popup=yes,width=1440,height=960');
      if (!previewWindow) return false;
      try {
        previewWindow.opener = null;
        previewWindow.document.open();
        previewWindow.document.write(previewWindowDocument(candidate));
        previewWindow.document.close();
        previewWindow.focus?.();
        return true;
      } catch {
        try { previewWindow.close?.(); } catch {}
        return false;
      }
    }

    function createActionIcon(kind) {
      const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const paths = kind === 'download'
        ? ['M12 3v11', 'm7 10 5 5 5-5', 'M5 20h14']
        : ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z'];
      paths.forEach((d) => {
        const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.append(path);
      });
      if (kind === 'open') {
        const pupil = documentRef.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pupil.setAttribute('cx', '12');
        pupil.setAttribute('cy', '12');
        pupil.setAttribute('r', '3');
        svg.append(pupil);
      }
      return svg;
    }

    function createPreviewCard(candidate) {
      const card = documentRef.createElement('section');
      card.className = 'web-preview-card';
      card.dataset.webPreviewCard = '1';
      card.dataset.webPreviewId = candidate.id || '';
      card.dataset.copyExclude = '1';

      const icon = documentRef.createElement('span');
      icon.className = 'web-preview-card-icon';
      icon.textContent = '</>';
      icon.setAttribute('aria-hidden', 'true');

      const copy = documentRef.createElement('div');
      copy.className = 'web-preview-card-copy';
      const title = documentRef.createElement('strong');
      title.textContent = candidate.title || '\u7f51\u9875\u9884\u89c8';
      const description = documentRef.createElement('span');
      description.textContent = '\u68c0\u6d4b\u5230\u5b8c\u6574 HTML \u7f51\u9875\uff0c\u53ef\u5728\u9694\u79bb\u73af\u5883\u4e2d\u9884\u89c8\u3002';
      copy.append(title, description);

      const actions = documentRef.createElement('div');
      actions.className = 'web-preview-card-actions';

      const open = documentRef.createElement('button');
      open.type = 'button';
      open.className = 'web-preview-open-btn';
      open.dataset.webPreviewId = candidate.id || '';
      open.title = '\u5728\u65b0\u7a97\u53e3\u6253\u5f00\u7f51\u9875';
      open.setAttribute('aria-label', `\u5728\u65b0\u7a97\u53e3\u6253\u5f00\u7f51\u9875: ${candidate.title || 'HTML \u7f51\u9875'}`);
      open.append(createActionIcon('open'));
      open.addEventListener('click', event => {
        // A streamed message can still be finishing its DOM work when the card becomes clickable.
        // Keep this action isolated from message/global click handlers so the first activation is not lost.
        event.preventDefault();
        event.stopPropagation();
        if (!openPreviewInNewWindow(candidate)) openPreview(candidate, open);
      });

      const download = documentRef.createElement('button');
      download.type = 'button';
      download.className = 'web-preview-download-btn';
      download.dataset.webPreviewId = candidate.id || '';
      download.title = '\u4e0b\u8f7d\u7f51\u9875';
      download.setAttribute('aria-label', `\u4e0b\u8f7d\u7f51\u9875: ${candidate.title || 'HTML \u7f51\u9875'}`);
      download.append(createActionIcon('download'));
      download.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        downloadPreview(candidate);
      });
      actions.append(open, download);
      card.append(icon, copy, actions);
      return card;
    }

    function syncMessagePreviews(messageNode, rawText = '') {
      if (!messageNode?.classList?.contains('assistant')) return 0;
      const content = messageNode.querySelector?.('.content');
      if (!content) return 0;
      content.querySelectorAll('[data-web-preview-card="1"]').forEach(node => node.remove());
      const candidates = core.extractWebPreviewCandidates(rawText);
      messageNode.__webPreviewCandidates = candidates;
      candidates.forEach(candidate => content.append(createPreviewCard(candidate)));
      return candidates.length;
    }

    function closePreview() {
      const modal = getElement('webPreview');
      const frame = getElement('webPreviewFrame');
      if (!modal) return false;
      const active = documentRef.activeElement;
      const returnFocus = modal.__webPreviewReturnFocus;
      if (active && modal.contains(active)) {
        if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus?.({ preventScroll: true });
        else active.blur?.();
      }
      frame?.removeAttribute('srcdoc');
      getElement('webPreviewDownload') && (getElement('webPreviewDownload').disabled = true);
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      delete modal.__webPreviewCandidate;
      delete modal.__webPreviewReturnFocus;
      return true;
    }

    function openPreview(candidate, trigger = null) {
      if (!candidate?.source) return false;
      const modal = getElement('webPreview');
      const frame = getElement('webPreviewFrame');
      const title = getElement('webPreviewTitle');
      if (!modal || !frame) return false;
      bindModalEvents();
      title && (title.textContent = candidate.title || '\u7f51\u9875\u9884\u89c8');
      modal.__webPreviewCandidate = candidate;
      getElement('webPreviewDownload') && (getElement('webPreviewDownload').disabled = false);
      modal.__webPreviewReturnFocus = trigger || documentRef.activeElement;

      // Reveal the dialog before loading srcdoc. In Chromium-based browsers, assigning an iframe
      // document while its fixed parent is display:none can defer the initial navigation until a
      // later interaction. Clearing a previous document also guarantees a fresh first navigation.
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      // Commit the display change before assigning srcdoc. Without a layout flush, some browsers
      // treat the first iframe navigation as if it still belongs to a display:none parent.
      modal.getBoundingClientRect();
      frame.removeAttribute('srcdoc');
      frame.setAttribute('srcdoc', core.buildPreviewDocument(candidate.source));
      getElement('webPreviewClose')?.focus?.({ preventScroll: true });
      return true;
    }

    function bindModalEvents() {
      const modal = getElement('webPreview');
      if (!modal || modal.dataset.webPreviewBound === '1') return;
      modal.dataset.webPreviewBound = '1';
      getElement('webPreviewClose')?.addEventListener('click', closePreview);
      getElement('webPreviewDownload')?.addEventListener('click', () => downloadPreview(modal.__webPreviewCandidate));
      modal.addEventListener('click', event => { if (event.target === modal) closePreview(); });
      documentRef.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('show')) {
          event.preventDefault();
          closePreview();
        }
      });
    }

    // Bind static dialog controls as soon as the controller is created, rather than waiting for
    // the first card click. This removes first-use listener setup from the activation path.
    bindModalEvents();
    return Object.freeze({ syncMessagePreviews, openPreview, openPreviewInNewWindow, closePreview, downloadPreview, bindModalEvents });
  }

  function getDefaultController() {
    return defaultController || (defaultController = createWebPreviewController());
  }

  const api = Object.freeze({
    createWebPreviewController,
    syncMessagePreviews(...args) { return getDefaultController().syncMessagePreviews(...args); },
    openPreview(...args) { return getDefaultController().openPreview(...args); },
    closePreview(...args) { return getDefaultController().closePreview(...args); },
    downloadPreview(...args) { return getDefaultController().downloadPreview(...args); },
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIWebPreview = api;
  if (root?.window) root.window.ChatUIWebPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
