(function initChatUIAppDisplayHistoryWorkflow(root) {
  // Intentionally not strict: workflow bodies use a dependency scope supplied by app.js.

  function createDisplayHistoryWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const messageRecords = deps.messageRecords || root.ChatUIMessageRecords || {};

    function decodeQuoteAttr(value = '') {
      return String(value || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    }

    function extractQuoteContextFromHtml(html = '') {
      const source = String(html || '');
      if (!source.includes('sent-quote-preview')) return '';
      try {
        const doc = deps.document || root?.document;
        if (doc?.createElement) {
          const tpl = doc.createElement('template');
          tpl.innerHTML = source;
          const value = tpl.content.querySelector('.sent-quote-preview')?.dataset?.quoteContext || '';
          if (value) return value;
        }
      } catch {}
      const match = source.match(/class=["'][^"']*sent-quote-preview[^"']*["'][\s\S]*?data-quote-context=(["'])([\s\S]*?)\1/i)
        || source.match(/data-quote-context=(["'])([\s\S]*?)\1[\s\S]*?class=["'][^"']*sent-quote-preview/i);
      return match ? decodeQuoteAttr(match[2]) : '';
    }

    function cleanPendingContent(node) {
      const lazy = node.dataset.lazyMarkdown === '1' || node.dataset.virtualized === '1';
      const content = lazy ? null : node.querySelector('.content')?.cloneNode(true);
      content?.querySelectorAll('.reasoning-panel,[data-image-action-clone]').forEach(child => child.remove());
      content?.querySelectorAll('[data-preview-bound],[data-download-bound],[data-copy-bound],[data-mermaid-toggle-bound],[data-quote-jump-bound]').forEach(child => {
        child.removeAttribute('data-preview-bound');
        child.removeAttribute('data-download-bound');
        child.removeAttribute('data-copy-bound');
        child.removeAttribute('data-mermaid-toggle-bound');
        child.removeAttribute('data-quote-jump-bound');
      });
      content?.querySelectorAll('img[data-persisted-src]').forEach(image => {
        image.dataset.originalSrc = image.dataset.persistedSrc;
        image.removeAttribute('src');
        image.classList.remove('image-missing');
        image.classList.add('image-restoring');
        image.removeAttribute('data-object-url');
      });
      content?.querySelectorAll('a[data-persisted-href]').forEach(link => {
        link.setAttribute('href', link.dataset.persistedHref);
        link.removeAttribute('data-object-url');
      });
      content?.querySelectorAll('button[data-persisted-href]').forEach(button => button.removeAttribute('data-object-url'));
      return { lazy, content };
    }

    function pendingItemFromNode(node) {
      const { lazy, content } = cleanPendingContent(node);
      const item = {
        id: node.dataset.displayItemId || node.__displayItem?.id || deps.makeDisplayItemId(),
        role: node.classList.contains('user') ? 'user' : node.classList.contains('error') ? 'error' : 'assistant',
        rawText: node.dataset.rawText || node.__displayItem?.rawText || '',
        html: lazy ? node.__displayItem?.html || '' : content?.innerHTML || node.__displayItem?.html || '',
        reasoningText: deps.state.reasoningMode && node.dataset.keepReasoning === '1' ? node.dataset.reasoningText || '' : '',
        keepReasoning: deps.state.reasoningMode && node.dataset.keepReasoning === '1',
        messageIndex: node.dataset.messageIndex || node.__displayItem?.messageIndex || '',
        responseIndex: node.dataset.responseIndex || node.__displayItem?.responseIndex || '',
        jobId: node.dataset.jobId || node.__displayItem?.jobId || '',
        imageContext: node.dataset.imageContext || node.__displayItem?.imageContext || '',
        attachmentContext: node.dataset.attachmentContext || node.__displayItem?.attachmentContext || '',
        quoteContext: node.dataset.quoteContext || content?.querySelector?.('.sent-quote-preview')?.dataset?.quoteContext || node.__displayItem?.quoteContext || '',
        metaText: deps.readMessageMetaText(node),
        pending: '1',
      };
      if (node.__displayItem) Object.assign(node.__displayItem, item);
      return node.__displayItem || item;
    }

    let lastPendingSnapshotKey = '';

    function saveDisplayHistory() {
      with (deps) {
        const session = getActiveSession();
        if (!session) return;
        // Never serialize completed DOM back into history. The DOM may contain only
        // the newest virtualized tail; treating it as the full session deletes older
        // media. Only resumable/transient items live in session.display.
        const currentPending = (session.display || []).filter(item => item?.pending === '1');
        const pendingIds = new Set(currentPending.map(item => String(item.id || '')).filter(Boolean));
        const pendingJobIds = new Set(currentPending.map(item => String(item.jobId || '')).filter(Boolean));
        const nodes = [...$('messages').querySelectorAll('.message')].filter(node => {
          if (node.__displayItem?.pending === '1') return true;
          const displayId = String(node.dataset.displayItemId || '');
          const jobId = String(node.dataset.jobId || '');
          return displayId && pendingIds.has(displayId) || jobId && pendingJobIds.has(jobId);
        });
        const fromDom = nodes.map(pendingItemFromNode).map(sanitizeStoredDisplayItem);
        const byId = new Map();
        currentPending.forEach(item => byId.set(item.id || item.jobId || `legacy:${byId.size}`, item));
        fromDom.forEach(item => byId.set(item.id || item.jobId || `dom:${byId.size}`, item));
        session.display = compactDisplayItems([...byId.values()].filter(item => item?.pending === '1'));
        const snapshotKey = `${session.id}|${JSON.stringify(session.display.map(item => ({ id: item.id || '', jobId: item.jobId || '', rawText: item.rawText || '', html: item.html || '', reasoningText: item.reasoningText || '', responseIndex: item.responseIndex || '', messageIndex: item.messageIndex || '', imageContext: item.imageContext || '', attachmentContext: item.attachmentContext || '' })))}`;
        if (snapshotKey === lastPendingSnapshotKey) return;
        session.updatedAt = Date.now();
        persistSessionDisplay(session.id);
        lastPendingSnapshotKey = snapshotKey;
      }
    }

    function restorePendingDisplayItems(session, pendingItems = []) {
      with (deps) {
        if (!session || !pendingItems.length) return;
        const activeImageJob = loadImageJob(session.id);
        const activeChatJob = loadLatestChatJob(session.id);
        const activeJobIds = new Set([activeImageJob?.id, activeChatJob?.id].filter(Boolean));
        const sessionActive = !!(isSessionBusy(session.id) || getActiveRun(session.id));
        const userCount = Array.isArray(session.messages) ? session.messages.filter(item => item?.role === 'user').length : 0;
        const assistantCount = Array.isArray(session.messages) ? session.messages.filter(item => item?.role === 'assistant' && !isChatStatusText(item.content || item.rawText || '')).length : 0;
        const hasCompletePair = userCount > 0 && assistantCount >= userCount;
        // A persisted chat job is explicit recovery evidence. Message-count
        // heuristics are not allowed to clear it: snapshots can contain a prior
        // assistant response while a replacement or a newly-started response is
        // still pending.
        if (hasCompletePair && !activeChatJob?.id) clearChatJob(session.id);
        const hasCompletedImage = item => {
          if (!isImagePendingDisplayItem(item)) return false;
          const jobId = String(item.jobId || ''), displayId = String(item.id || ''), responseIndex = String(item.responseIndex || '');
          return (session.messages || []).some(message => message?.role === 'assistant' && /^\[图片(生成|编辑|修改)完成\]/.test(String(message.content || '')) && (
            jobId && String(message.imageJobId || '') === jobId ||
            displayId && String(message.displayItemId || '') === displayId ||
            responseIndex && String(message.responseIndex || '') === responseIndex
          ));
        };
        const hasCompletedChat = item => !isImagePendingDisplayItem(item) && sessionHasCompletedAssistantForResponse(session, item.responseIndex);
        const matchesActiveChatJob = item => !!activeChatJob?.id && !isImagePendingDisplayItem(item) && (
          String(item.jobId || '') === String(activeChatJob.id)
          || (item.id && activeChatJob.displayItemId && String(item.id) === String(activeChatJob.displayItemId))
          || (item.responseIndex !== '' && item.responseIndex !== undefined && activeChatJob.responseIndex !== '' && activeChatJob.responseIndex !== undefined && String(item.responseIndex) === String(activeChatJob.responseIndex))
        );
        // Reconcile a lagging pending snapshot to the durable job before stale
        // pending cleanup can discard the UI anchor needed after a switch/refresh.
        (pendingItems || []).forEach(item => {
          if (item?.pending === '1' && matchesActiveChatJob(item)) item.jobId = activeChatJob.id;
        });
        const hasMeaningfulText = item => !!String(item.rawText || '').trim() && !isChatStatusText(item.rawText || '');
        const shouldKeepPending = item => isImagePendingDisplayItem(item)
          ? !hasCompletedImage(item) && item.jobId && activeJobIds.has(item.jobId)
          : !hasCompletedChat(item) && (matchesActiveChatJob(item) || (item.jobId && activeJobIds.has(item.jobId)) || (!item.jobId && sessionActive) || hasMeaningfulText(item));
        const keptPending = pendingItems.filter(item => item?.pending === '1' && shouldKeepPending(item));
        if (session.display?.length) {
          const before = session.display.length;
          session.display = session.display.filter(item => !(item?.pending === '1' && !shouldKeepPending(item)));
          if (session.display.length !== before) persistSessionDisplay(session.id);
        }
        for (const item of keptPending) {
          item.id ||= makeDisplayItemId();
          const stored = session.display.find(candidate => candidate.id === item.id);
          if (stored) Object.assign(stored, item);
          else session.display.push(item);
          if (session.id !== state.activeSessionId) continue;
          let node = null;
          const nodes = [...$('messages').querySelectorAll('.message')];
          if (item.id) node = nodes.find(candidate => candidate.dataset.displayItemId === item.id) || null;
          if (!node && item.jobId) node = nodes.find(candidate => candidate.dataset.jobId === item.jobId) || null;
          const responseIndex = Number(item.responseIndex);
          if (!node && Number.isFinite(responseIndex) && responseIndex >= 0) node = nodes.find(candidate => candidate.classList.contains('assistant') && candidate.dataset.responseIndex === String(responseIndex)) || null;
          if (!node) {
            node = addDisplayItemNode(item);
            if (item.jobId) node.dataset.jobId = item.jobId;
            if (Number.isFinite(responseIndex) && responseIndex >= 0) {
              const anchor = [...$('messages').querySelectorAll('.message')].find(candidate => candidate !== node && Number(candidate.classList.contains('user') ? candidate.dataset.messageIndex : candidate.dataset.responseIndex) > responseIndex);
              if (anchor?.parentNode) anchor.parentNode.insertBefore(node, anchor);
            }
          } else {
            node.__displayItem = item;
            if (item.id) node.dataset.displayItemId = item.id;
            if (item.jobId) node.dataset.jobId = item.jobId;
            if (Number.isFinite(responseIndex) && responseIndex >= 0) node.dataset.responseIndex = String(responseIndex);
          }
        }
        session.display = compactDisplayItems(session.display.filter(item => item?.pending === '1'));
        persistSessionDisplay(session.id);
      }
    }

    function escapeHtml(value = '') {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function durableMediaDescriptorRef(item = {}) {
      const candidates = [item.src, item.url, item.dataUrl, item.data_url, item.previewSrc, item.preview_src];
      for (const candidate of candidates) {
        const ref = messageRecords.durableMediaRef
          ? messageRecords.durableMediaRef(candidate)
          : String(candidate || '').trim().replace(/^(?:data:|blob:).*/i, '');
        if (ref) return ref;
      }
      return '';
    }

    function imagePresentationHtml(message, presentation) {
      const images = (presentation?.images || messageRecords.presentationImages?.(message) || [])
        .filter(item => durableMediaDescriptorRef(item));
      if (!images.length) return '';
      const transparent = root.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      const items = images.map((item, index) => {
        const width = Number(item.width) || 180;
        const height = Number(item.height) || 120;
        const scale = Math.min(180 / width, 120 / height, 1);
        const thumbWidth = Math.max(1, Math.round(width * scale));
        const thumbHeight = Math.max(1, Math.round(height * scale));
        const src = durableMediaDescriptorRef(item);
        const referenceId = item.referenceId || item.reference_id || 'imgref_latest';
        const imageId = item.imageId || item.image_id || item.id || `img_latest_${index + 1}`;
        return `<div class="generated-image-item" data-image-index="${index + 1}" aria-label="第 ${index + 1} 张图片"><img class="generated-thumb image-restoring" width="${thumbWidth}" height="${thumbHeight}" style="--thumb-w:${thumbWidth}px;--thumb-h:${thumbHeight}px;width:${thumbWidth}px;height:${thumbHeight}px;aspect-ratio:${thumbWidth}/${thumbHeight};object-fit:contain" src="${transparent}" data-persisted-src="${escapeHtml(src)}" data-original-src="${escapeHtml(src)}" data-filename="${escapeHtml(item.name || item.filename || `image-${index + 1}.png`)}" data-reference-id="${escapeHtml(referenceId)}" data-image-id="${escapeHtml(imageId)}" data-image-index="${index + 1}" data-thumb-width="${thumbWidth}" data-thumb-height="${thumbHeight}" data-original-width="${width}" data-original-height="${height}" alt="第 ${index + 1} 张生成图片" /></div>`;
      }).join('');
      const head = images.length > 1 ? `<div class="image-result-head"><span>（${images.length} 张）</span></div>` : '';
      const actions = typeof deps.downloadAllImagesButtonHtml === 'function' ? deps.downloadAllImagesButtonHtml() : '';
      return `${head}<div class="generated-image-grid" data-generated-images="1">${items}</div>${actions ? `<div class="image-download-row">${actions}</div>` : ''}`;
    }

    function attachmentPresentationHtml(message, presentation) {
      if (typeof deps.renderUserMessageWithAttachments !== 'function') return '';
      const attachments = (presentation?.attachments || messageRecords.presentationAttachments?.(message) || []).map(item => ({
        ...item,
        dataUrl: item.dataUrl || item.src || '',
        attachmentId: item.attachmentId || item.attachment_id || item.id || '',
      }));
      if (!attachments.length) return '';
      return deps.renderUserMessageWithAttachments(presentation.displayText || '', attachments);
    }

    function renderMessageFromCanonical(session, message, fallbackIndex) {
      with (deps) {
        const normalized = messageRecords.normalizeCanonicalMessage
          ? messageRecords.normalizeCanonicalMessage(message, { sessionId: session?.id || state.activeSessionId || 'session', sequence: fallbackIndex })
          : message;
        const presentation = normalized?.presentation || {};
        const canonicalIndex = normalized?.role === 'user' && normalized?.messageIndex !== undefined && normalized.messageIndex !== ''
          ? Number(normalized.messageIndex)
          : normalized?.role === 'assistant' && normalized?.responseIndex !== undefined && normalized.responseIndex !== ''
            ? Number(normalized.responseIndex)
            : fallbackIndex;
        const persistedHtml = normalized?.html || presentation.html || '';
        const quoteContext = normalized?.quoteContext || extractQuoteContextFromHtml(persistedHtml) || '';
        // Canonical descriptors are durable semantic data. Persisted HTML is only a
        // compatibility fallback and must never override richer image/file records.
        const descriptorHtml = presentation.kind === 'attachment'
          ? attachmentPresentationHtml(normalized, presentation)
          : presentation.kind === 'image-result'
            ? imagePresentationHtml(normalized, presentation)
            : '';
        const html = descriptorHtml || persistedHtml;
        const displayText = presentation.displayText || (normalized.role === 'user' ? normalized.rawText || normalized.content : normalized.content);
        const rich = !!html && (displayItemHasRichMedia({ html }) || presentation.kind === 'attachment' || presentation.kind === 'image-result');
        const node = rich
          ? addMessage(normalized.role === 'assistant' ? 'assistant' : normalized.role === 'error' ? 'error' : 'user', html, {
              html: true,
              rawText: displayText,
              metaText: normalized.metaText || '',
              quoteContext,
              messageIndex: normalized.role === 'user' ? canonicalIndex : null,
              responseIndex: normalized.role === 'assistant' ? canonicalIndex : null,
              deferSave: true,
              noScroll: true,
              deferEnhance: false,
            })
          : addMessage(normalized.role === 'assistant' ? 'assistant' : 'user', displayText, {
              rawText: displayText,
              metaText: normalized.metaText || '',
              quoteContext,
              messageIndex: normalized.role === 'user' ? canonicalIndex : null,
              responseIndex: normalized.role === 'assistant' ? canonicalIndex : null,
              deferSave: true,
              noScroll: true,
              lazy: false,
              deferEnhance: false,
            });
        // A saved reasoning trace belongs to this response even when reasoning is
        // currently disabled for new requests. Restore it independently of the
        // composer preference so a refresh cannot hide completed history.
        if (normalized?.reasoning_content && normalized.role === 'assistant') updateReasoning(node, normalized.reasoning_content, { done: true, keepReasoning: true, restoreHistory: true });
        node.dataset.rawText = String(displayText || '');
        if (normalized.id) node.dataset.messageId = normalized.id;
        if (normalized.role === 'user') node.dataset.messageIndex = String(canonicalIndex);
        if (normalized.role === 'assistant') node.dataset.responseIndex = String(canonicalIndex);
        if (normalized.displayItemId) node.dataset.displayItemId = String(normalized.displayItemId);
        if (normalized.imageJobId) node.dataset.imageJobId = String(normalized.imageJobId);
        if (normalized.imageContext) node.dataset.imageContext = normalized.imageContext;
        if (normalized.attachmentContext) node.dataset.attachmentContext = normalized.attachmentContext;
        if (quoteContext) node.dataset.quoteContext = quoteContext;
        return node;
      }
    }

    return Object.freeze({ saveDisplayHistory, restorePendingDisplayItems, renderMessageFromCanonical });
  }

  const api = Object.freeze({ createDisplayHistoryWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppDisplayHistoryWorkflow = api;
  if (root?.window) root.window.ChatUIAppDisplayHistoryWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
