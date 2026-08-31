(function initChatUIAppDisplayHistoryWorkflow(root) {
  // Intentionally not strict: workflow bodies use a dependency scope supplied by app.js.

  const messagePrimitives = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (typeof require === 'function' ? require('../core/message-primitives') : {});
  const { isDurableImageCompletionMessage } = messagePrimitives;

  function createDisplayHistoryWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const messageRecords = deps.messageRecords || root.ChatUIMessageRecords || {};
    const clarificationPresentation = deps.clarificationPresentation
      || root?.ChatUIApp?.appContext?.getWorkflowModule?.('clarificationPresentation')
      || {};

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
        reasoningText: node.dataset.keepReasoning === '1' ? node.dataset.reasoningText || '' : '',
        keepReasoning: node.dataset.keepReasoning === '1',
        messageIndex: node.dataset.messageIndex || node.__displayItem?.messageIndex || '',
        responseIndex: node.dataset.responseIndex || node.__displayItem?.responseIndex || '',
        messageId: node.dataset.messageId || node.__displayItem?.messageId || '',
        turnId: node.dataset.turnId || node.__displayItem?.turnId || '',
        replyToMessageId: node.dataset.replyToMessageId || node.__displayItem?.replyToMessageId || '',
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

    function pendingTaskProjectionOwner(pendingSubmit, activeImageJob, activeChatJob) {
      if (pendingSubmit) {
        const requestedKind = pendingSubmit.jobKind === 'image' ? 'image' : pendingSubmit.jobKind === 'chat' ? 'chat' : '';
        const requestedJobId = String(pendingSubmit.jobId || '');
        const matchingJob = requestedKind === 'image' && (!requestedJobId || String(activeImageJob?.id || '') === requestedJobId)
          ? activeImageJob
          : requestedKind === 'chat' && (!requestedJobId || String(activeChatJob?.id || '') === requestedJobId)
            ? activeChatJob
            : null;
        const inferredKind = requestedKind || (matchingJob ? (matchingJob === activeImageJob ? 'image' : 'chat') : ['image', 'edit_image'].includes(pendingSubmit.submitMode) ? 'image' : 'chat');
        return { kind: inferredKind, pendingSubmit, job: matchingJob };
      }
      if (activeImageJob?.id) return { kind: 'image', pendingSubmit: null, job: activeImageJob };
      if (activeChatJob?.id) return { kind: 'chat', pendingSubmit: null, job: activeChatJob };
      return null;
    }

    function pendingStatusElapsedSeconds(text = '') {
      const match = /\u5df2\u7b49\u5f85\s*(\d+)\s*\u79d2/.exec(String(text || '').trim());
      return match ? Number(match[1]) : null;
    }

    function pendingTaskProjectionStatus(owner) {
      const pending = owner?.pendingSubmit;
      const job = owner?.job;
      const startedAt = Number(job?.startedAt || pending?.startedAt || 0);
      const elapsed = startedAt > 0 ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
      if (pending) {
        if (pending.stage === 'accepted') return '\u6b63\u5728\u63a5\u6536\u4efb\u52a1';
        if (pending.stage === 'captured') return '\u6b63\u5728\u51c6\u5907\u6d88\u606f';
        if (pending.stage === 'routing') return '\u6b63\u5728\u8bc6\u522b\u4efb\u52a1';
        if (pending.stage === 'handoff') return owner.kind === 'image' ? '\u6b63\u5728\u542f\u52a8\u56fe\u7247\u4efb\u52a1' : '\u6b63\u5728\u8fde\u63a5\u6a21\u578b';
      }
      if (owner?.kind === 'image') {
        const editing = job?.mode === 'edit_image' || job?.imageContext?.mode === 'edit_image';
        return `${editing ? '\u6b63\u5728\u4fee\u6539\u56fe\u7247' : '\u6b63\u5728\u751f\u6210\u56fe\u7247'} \u5df2\u7b49\u5f85 ${elapsed} \u79d2`;
      }
      return `\u6b63\u5728\u5904\u7406 \u5df2\u7b49\u5f85 ${elapsed} \u79d2`;
    }

    function ensurePendingTaskProjection(session, pendingItems, pendingSubmit, activeImageJob, activeChatJob) {
      const owner = pendingTaskProjectionOwner(pendingSubmit, activeImageJob, activeChatJob);
      if (!owner) return Array.isArray(pendingItems) ? pendingItems : [];
      session.display ||= [];
      const job = owner.job || {};
      const pending = owner.pendingSubmit || {};
      const displayId = root?.ChatUIAppJobWorkflow?.pendingSubmitDisplayId?.(pending)
        || String(job.displayItemId || '')
        || (job.id ? `pending-${owner.kind}-${job.id}` : '');
      const jobId = String(job.id || pending.jobId || '');
      const responseIndex = pending.responseIndex ?? job.responseIndex ?? '';
      const allItems = [...session.display, ...(Array.isArray(pendingItems) ? pendingItems : [])];
      let item = allItems.find(candidate => displayId && String(candidate?.id || '') === displayId)
        || allItems.find(candidate => jobId && String(candidate?.jobId || '') === jobId)
        || allItems.find(candidate => responseIndex !== '' && responseIndex !== null && responseIndex !== undefined && candidate?.pending === '1' && String(candidate?.responseIndex || '') === String(responseIndex))
        || null;
      let changed = false;
      const statusText = pendingTaskProjectionStatus(owner);
      if (!item) {
        const html = typeof deps.pendingFeedbackHtml === 'function' ? deps.pendingFeedbackHtml(statusText) : '';
        item = {
          id: displayId || deps.makeDisplayItemId(),
          role: 'assistant',
          rawText: statusText,
          html,
          reasoningText: '',
          keepReasoning: false,
          messageIndex: '',
          responseIndex: responseIndex !== '' && responseIndex !== null && responseIndex !== undefined ? String(responseIndex) : '',
          jobId,
          imageContext: '',
          attachmentContext: '',
          quoteContext: '',
          metaText: '',
          pending: '1',
        };
        session.display.push(item);
        changed = true;
      } else {
        if (!item.id && displayId) { item.id = displayId; changed = true; }
        if (!item.jobId && jobId) { item.jobId = jobId; changed = true; }
        if ((item.responseIndex === '' || item.responseIndex === null || item.responseIndex === undefined) && responseIndex !== '' && responseIndex !== null && responseIndex !== undefined) { item.responseIndex = String(responseIndex); changed = true; }
        if (item.pending !== '1') { item.pending = '1'; changed = true; }
        const currentText = String(item.rawText || '').trim();
        const currentIsStatus = !currentText || deps.isChatStatusText?.(currentText);
        if (currentIsStatus && currentText !== statusText) {
          // The projection is a durable-job recovery hint, never the live
          // source of truth: a running UI timer keeps the item's status
          // fresher than any recomputed snapshot. Switching sessions must not
          // downgrade an already ticking elapsed status (for example to
          // "已等待 0 秒" when the durable job snapshot lost its startedAt),
          // otherwise the restored bubble freezes at zero seconds. Only
          // replace a status when the projection is strictly newer than what
          // is already displayed.
          const currentElapsed = pendingStatusElapsedSeconds(currentText);
          const projectionElapsed = pendingStatusElapsedSeconds(statusText);
          const projectionFresher = currentElapsed === null
            || (projectionElapsed !== null && projectionElapsed > currentElapsed);
          if (projectionFresher) {
            item.rawText = statusText;
            item.html = typeof deps.pendingFeedbackHtml === 'function' ? deps.pendingFeedbackHtml(statusText) : item.html || '';
            changed = true;
          }
        }
        if (!session.display.includes(item)) { session.display.push(item); changed = true; }
      }
      const projected = Array.isArray(pendingItems) ? [...pendingItems] : [];
      if (!projected.includes(item)) projected.push(item);
      if (changed) deps.persistSessionDisplay(session.id);
      return projected;
    }

    function restorePendingDisplayItems(session, pendingItems = []) {
      with (deps) {
        if (!session) return;
        const activeImageJob = loadImageJob(session.id);
        const activeChatJob = loadLatestChatJob(session.id);
        const pendingSubmit = typeof loadPendingSubmit === 'function' ? loadPendingSubmit(session.id) : null;
        pendingItems = ensurePendingTaskProjection(session, pendingItems, pendingSubmit, activeImageJob, activeChatJob);
        if (!pendingItems.length) return;
        const activeJobIds = new Set([activeImageJob?.id, activeChatJob?.id].filter(Boolean));
        const sessionActive = !!(isSessionBusy(session.id) || getActiveRun(session.id) || pendingSubmit);
        const userCount = Array.isArray(session.messages) ? session.messages.filter(item => item?.role === 'user').length : 0;
        const assistantCount = Array.isArray(session.messages) ? session.messages.filter(item => item?.role === 'assistant' && !isChatStatusText(item.content || item.rawText || '')).length : 0;
        const hasCompletePair = userCount > 0 && assistantCount >= userCount;
        // A persisted chat job is explicit recovery evidence. Message-count
        // heuristics are not allowed to clear it: snapshots can contain a prior
        // assistant response while a replacement or a newly-started response is
        // still pending.
        if (hasCompletePair && !activeChatJob?.id) clearChatJob(session.id);
        // A batch parent card is an image pending item even before any child
        // result arrives (its rawText is a "任务 N/M：" / "正在生成 x/y 张图片"
        // status and it has no imageContext yet). Without recognizing it here,
        // restorePendingDisplayItems treats it as a non-image pending item and
        // drops it on a session switch, so the in-flight "正在生成图片" slots
        // are not restored.
        const isImageBatchPendingItem = item => {
          const jobId = String(item?.jobId || '');
          const rawText = String(item?.rawText || '');
          return /^imgbatch-/.test(jobId)
            || /^任务\s*\d+(?:\/\d+)?：/.test(rawText)
            || /正在生成\s*\d+\/\d+\s*张图片/.test(rawText)
            || /已完成\s*\d+\/\d+\s*张图片/.test(rawText)
            || /图片生成完成/.test(rawText);
        };
        const hasCompletedImage = item => {
          if (!isImagePendingDisplayItem(item) && !isImageBatchPendingItem(item)) return false;
          const jobId = String(item.jobId || ''), displayId = String(item.id || ''), responseIndex = String(item.responseIndex || '');
          return (session.messages || []).some(message => (
            typeof isDurableImageCompletionMessage === 'function'
            && isDurableImageCompletionMessage(message)
            && (
              jobId && String(message.imageJobId || '') === jobId ||
              displayId && String(message.displayItemId || '') === displayId ||
              responseIndex && String(message.responseIndex || '') === responseIndex
            )
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
        const shouldKeepPending = item => isImageBatchPendingItem(item)
          ? !hasCompletedImage(item) && String(item.jobId || '').trim() !== ''
          : isImagePendingDisplayItem(item)
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
            const rawText = String(item.rawText || '');
            if (rawText && String(node.dataset.rawText || '') !== rawText) {
              if (item.html && typeof updateMessage === 'function') updateMessage(node, item.html, { html: true, rawText, skipSave: true, noScroll: true, responseIndex: Number.isFinite(responseIndex) ? responseIndex : undefined });
              else if (typeof updateMessageContentLight === 'function') updateMessageContentLight(node, rawText, { rawText, pending: true, skipSave: true, noScroll: true, streamKind: 'chat', sessionId: session.id, responseIndex: Number.isFinite(responseIndex) ? responseIndex : undefined });
            }
            if (item.reasoningText && typeof updateReasoning === 'function') updateReasoning(node, item.reasoningText, { done: false, keepReasoning: !!item.keepReasoning, keepEmpty: true, restoreHistory: true });
          }
          if (node) {
            node.dataset.streaming = '1';
            node.dataset.streamKind = (isImagePendingDisplayItem(item) || isImageBatchPendingItem(item)) ? 'image' : 'chat';
            node.dataset.sessionId = session.id;
            if (String(item.html || '').includes('pending-feedback')) node.dataset.pendingFeedback = '1';
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
      const candidates = [item.src, item.persistedSrc, item.persisted_src, item.url, item.dataUrl, item.data_url, item.previewSrc, item.preview_src];
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
      const renderImageResultHtml = deps.imageResultRenderer
        || root?.ChatUIAppImageResultWorkflow?.renderImageResultHtml;
      if (typeof renderImageResultHtml !== 'function') return '';
      const transparent = root.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      return renderImageResultHtml(images.map(item => ({
        ...item,
        src: durableMediaDescriptorRef(item),
        displaySrc: '',
      })), {
        escapeHtml,
        downloadAllImagesButtonHtml: deps.downloadAllImagesButtonHtml,
        transparentPixel: transparent,
      });
    }

    function isClarificationPresentationHtml(html = '') {
      return /data-clarification-(?:image-choices|choice-options)=/i.test(String(html || ''));
    }

    function clarificationPresentationForMessage(session = {}, message = {}) {
      const descriptor = message?.clarification && typeof message.clarification === 'object' && !Array.isArray(message.clarification)
        ? message.clarification
        : null;
      const clarificationId = String(descriptor?.id || message?.clarificationId || message?.clarification_id || '').trim();
      const activePending = session?.pendingClarification;
      const pending = String(activePending?.id || '') === clarificationId ? activePending : null;
      const routeInfo = descriptor?.routeInfo || pending?.routeInfo;
      if (!clarificationId || !routeInfo || typeof routeInfo !== 'object' || Array.isArray(routeInfo)) return null;
      const presentation = clarificationPresentation.buildClarificationPresentation?.({
        ...routeInfo,
        clarificationQuestion: routeInfo.clarificationQuestion
          || descriptor?.question
          || pending?.clarificationText
          || message.content
          || '',
      }, {
        messages: Array.isArray(session.messages) ? session.messages : [],
        lastGeneratedImage: session.lastGeneratedImage || null,
        currentImageContext: descriptor?.sourceImageContext || pending?.sourceImageContext || null,
        quotedImageContext: descriptor?.sourceQuoteContext || pending?.sourceQuoteContext || null,
      });
      return presentation?.hasChoices && String(presentation.html || '').trim() ? presentation : null;
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
        const clarification = clarificationPresentationForMessage(session, normalized);
        const quoteContext = normalized?.quoteContext || extractQuoteContextFromHtml(persistedHtml) || '';
        // Canonical descriptors are durable semantic data. Persisted HTML is only a
        // compatibility fallback and must never override richer image/file records.
        const descriptorHtml = presentation.kind === 'attachment'
          ? attachmentPresentationHtml(normalized, presentation)
          : presentation.kind === 'image-result'
            ? imagePresentationHtml(normalized, presentation)
            : '';
        const html = descriptorHtml || clarification?.html || persistedHtml;
        const displayText = Object.prototype.hasOwnProperty.call(presentation, 'displayText')
          ? String(presentation.displayText || '')
          : normalized.role === 'user' ? normalized.rawText || normalized.content : normalized.content;
        const rich = !!html && (
          !!clarification
          || displayItemHasRichMedia({ html })
          || presentation.kind === 'attachment'
          || presentation.kind === 'image-result'
          || isClarificationPresentationHtml(persistedHtml)
        );
        const node = rich
          ? addMessage(normalized.role === 'assistant' ? 'assistant' : normalized.role === 'error' ? 'error' : 'user', html, {
              html: true,
              rawText: displayText,
              metaText: normalized.metaText || '',
              quoteContext,
              messageIndex: normalized.role === 'user' ? canonicalIndex : null,
              responseIndex: normalized.role === 'assistant' ? canonicalIndex : null,
              messageId: normalized.id || '',
              turnId: normalized.turnId || '',
              replyToMessageId: normalized.replyToMessageId || '',
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
              messageId: normalized.id || '',
              turnId: normalized.turnId || '',
              replyToMessageId: normalized.replyToMessageId || '',
              deferSave: true,
              noScroll: true,
              lazy: false,
              deferEnhance: false,
            });
        node.dataset.rawText = String(displayText || '');
        if (normalized.id) node.dataset.messageId = normalized.id;
        if (normalized.turnId) node.dataset.turnId = normalized.turnId;
        if (normalized.replyToMessageId) node.dataset.replyToMessageId = normalized.replyToMessageId;
        if (normalized.clarificationId || normalized.clarification_id) {
          node.dataset.clarificationId = String(normalized.clarificationId || normalized.clarification_id);
        }
        if (normalized.role === 'user') node.dataset.messageIndex = String(canonicalIndex);
        if (normalized.role === 'assistant') node.dataset.responseIndex = String(canonicalIndex);
        if (normalized.displayItemId) node.dataset.displayItemId = String(normalized.displayItemId);
        if (normalized.imageJobId) node.dataset.imageJobId = String(normalized.imageJobId);
        if (normalized.imageContext) node.dataset.imageContext = normalized.imageContext;
        if (normalized.attachmentContext) node.dataset.attachmentContext = normalized.attachmentContext;
        if (quoteContext) node.dataset.quoteContext = quoteContext;
        const reasoning = String(normalized?.reasoning_content || normalized?.reasoning || '').trim();
        if (reasoning && typeof updateReasoning === 'function') {
          updateReasoning(node, reasoning, { done: true, restoreHistory: true, expanded: false });
        }
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
