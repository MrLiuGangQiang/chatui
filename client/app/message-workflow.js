(function initChatUIAppMessageWorkflow(root) {
  // Intentionally not strict: message rendering bodies are migrated from app.js and resolved through a deps scope.

  const MESSAGE_ACTION_STATES = Object.freeze({ PENDING: 'pending', READY: 'ready' });

  function messageActionRole(node) {
    return node?.classList?.contains('user') ? 'user' : node?.classList?.contains('error') ? 'error' : 'assistant';
  }

  function resolveMessageActionState(node, requestedState = '') {
    const role = messageActionRole(node);
    if (role === 'user' || role === 'error') return MESSAGE_ACTION_STATES.READY;
    if (node?.dataset?.clarificationId) return MESSAGE_ACTION_STATES.READY;
    if (requestedState === MESSAGE_ACTION_STATES.PENDING || requestedState === MESSAGE_ACTION_STATES.READY) return requestedState;
    if (node?.dataset?.actionsState === MESSAGE_ACTION_STATES.READY) return MESSAGE_ACTION_STATES.READY;
    if (node?.dataset?.streaming === '1' || node?.dataset?.persist === '0' || node?.dataset?.pendingFeedback === '1' || node?.dataset?.actionsState === MESSAGE_ACTION_STATES.PENDING) return MESSAGE_ACTION_STATES.PENDING;
    return MESSAGE_ACTION_STATES.READY;
  }

  function applyMessageActionLifecycle(node, requestedState = '', resetMessageActionStates = () => {}, options = {}) {
    if (!node?.dataset) return null;
    const state = resolveMessageActionState(node, requestedState);
    node.dataset.actionsState = state;
    if (state === MESSAGE_ACTION_STATES.READY) {
      delete node.dataset.streaming;
      delete node.dataset.streamKind;
      delete node.dataset.streamRunToken;
      delete node.dataset.streamTailLock;
      delete node.dataset.pendingFeedback;
      delete node.dataset.jobId;
      if (!options.preservePersist) delete node.dataset.persist;
      delete node.dataset.sessionId;
      if (node.__displayItem) {
        node.__displayItem.pending = '';
        node.__displayItem.jobId = '';
      }
    } else {
      node.dataset.persist = '0';
    }
    const actions = node.querySelector?.('.msg-actions');
    if (actions) {
      actions.hidden = false;
      if (state === MESSAGE_ACTION_STATES.PENDING) actions.setAttribute('aria-hidden', 'true');
      else actions.removeAttribute('aria-hidden');
    }
    resetMessageActionStates(node);
    return state;
  }

  // Compatibility facade for callers that only need the terminal transition.
  function reconcileCompletedMessageUi(node, resetMessageActionStates = () => {}) {
    return applyMessageActionLifecycle(node, MESSAGE_ACTION_STATES.READY, resetMessageActionStates);
  }

  function copyComparableText(text = '') {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]*\n[ \t]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function selectedUserMessageRawText(selection) {
    if (!selection?.rangeCount || !String(selection.toString?.() || '').trim()) return '';
    const range = selection.getRangeAt(0);
    const asElement = node => node?.nodeType === 1 ? node : node?.parentElement || null;
    const start = asElement(range.startContainer)?.closest?.('.message.user .content') || null;
    const end = asElement(range.endContainer)?.closest?.('.message.user .content') || null;
    if (!start || start !== end) return '';
    const message = start.closest?.('.message.user');
    if (!message || message.querySelector('.user-attachment-preview-grid,.sent-quote-preview')) return '';
    const rawText = String(message.dataset?.rawText || '');
    return rawText && copyComparableText(selection.toString()) === copyComparableText(rawText)
      ? rawText.replace(/\r\n?/g, '\n')
      : '';
  }

  function createMessageWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    // Finalization can still change layout after a historical stream receives its
    // last token. Use the same output-end anchor as live updates so completion
    // cannot reintroduce a second, conflicting scroll position.
    const pinActiveOutputToAnchor = deps.pinActiveOutputToAnchor || deps.pinNodeBottomToTarget || (() => {});
    const commitStreamingOutput = deps.commitStreamingOutput || pinActiveOutputToAnchor;
    const commitLiveOutput = (node, options = {}) => commitStreamingOutput(node, {
      margin: 72,
      tailLock: options.tailLock === true,
      sessionId: options.sessionId || node?.dataset?.sessionId || state.activeSessionId,
      requireActive: options.requireActive === true,
      requireFollow: options.requireFollow === true,
    });
    const setDatasetValue = (node, key, value) => {
      if (!node?.dataset) return;
      const normalized = String(value ?? '');
      if (node.dataset[key] !== normalized) node.dataset[key] = normalized;
    };
    const documentRef = deps.document || root.document;
    if (typeof documentRef?.addEventListener === 'function' && !documentRef.__chatuiUserRawCopyBound) {
      documentRef.__chatuiUserRawCopyBound = true;
      documentRef.addEventListener('copy', event => {
        if (event.defaultPrevented || typeof event.clipboardData?.setData !== 'function') return;
        const rawText = selectedUserMessageRawText(documentRef.getSelection?.() || root.getSelection?.());
        if (!rawText) return;
        event.clipboardData.setData('text/plain', rawText);
        event.preventDefault();
      });
    }

    function cleanupGeneratedImageNumberArtifacts(root) {
      const scopeRoot = root?.querySelectorAll ? root : null;
      if (!scopeRoot) return;
      scopeRoot.querySelectorAll('.generated-image-item').forEach(item => {
        item.querySelectorAll(':scope > .generated-image-index').forEach(badge => badge.remove());
      });
      scopeRoot.querySelectorAll('.generated-image-index').forEach(badge => {
        badge.remove();
      });
    }

    function shouldProgressiveRenderMarkdown(text = '') {
      const raw = String(text || '');
      return raw.length > 8000 || raw.split('\n').length > 180;
    }

    const getWorkflowModule = name => root?.ChatUIApp?.appContext?.getWorkflowModule?.(name) || null;
    const messageDomain = getWorkflowModule('messageDomain') || {};
    const messageModel = getWorkflowModule('messageModel') || messageDomain;
    const messageRoleLabel = messageDomain.messageRoleLabel || (role => role === 'user' ? '我' : role === 'assistant' ? 'AI' : '消息');
    const messageRoleFromNode = messageDomain.messageRoleFromNode || (node => node?.classList?.contains('assistant') ? 'assistant' : node?.classList?.contains('user') ? 'user' : 'error');
    const normalizeQuoteText = messageDomain.normalizeQuoteText || ((text = '', limit = 1200) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit));
    const escapeHtmlLocal = messageDomain.escapeHtmlLocal || (value => String(value ?? '').replace(/[&<>\"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
    const readQuoteContext = messageDomain.readQuoteContext || (value => messageModel.normalizeQuoteContext?.(value, { normalizeQuoteText }) || null);
    const quoteContextJson = messageDomain.quoteContextJson || (value => messageModel.quoteContextJson?.(value, { normalizeQuoteText }) || '');

    const quotePreview = (getWorkflowModule('quotePreview')?.createQuotePreview || (() => ({ renderSentQuotePreview: () => '', withSentQuotePreview: html => String(html || '') })))({
      readQuoteContext,
      normalizeQuoteText,
      escapeHtml: escapeHtmlLocal,
    });
    const renderSentQuotePreview = quotePreview.renderSentQuotePreview;
    const withSentQuotePreview = quotePreview.withSentQuotePreview;

    function findQuotedMessageNode(quote) {
      const ctx = readQuoteContext(quote);
      if (!ctx) return null;
      if (ctx.sessionId && deps.state?.activeSessionId && ctx.sessionId !== deps.state.activeSessionId) return null;
      const root = deps.$?.('messages') || deps.document;
      if (!root?.querySelectorAll) return null;
      const nodes = [...root.querySelectorAll('.message')];
      if (ctx.displayItemId) {
        const byDisplay = nodes.find(node => node.dataset.displayItemId === ctx.displayItemId);
        if (byDisplay) return byDisplay;
      }
      if (ctx.role === 'assistant' && ctx.responseIndex !== undefined) {
        const byResponse = nodes.find(node => node.classList.contains('assistant') && String(node.dataset.responseIndex || '') === String(ctx.responseIndex));
        if (byResponse) return byResponse;
      }
      if (ctx.role === 'user' && ctx.messageIndex !== undefined) {
        const byMessage = nodes.find(node => node.classList.contains('user') && String(node.dataset.messageIndex || '') === String(ctx.messageIndex));
        if (byMessage) return byMessage;
      }
      return nodes.find(node => messageRoleFromNode(node) === ctx.role && normalizeQuoteText(node.dataset.rawText || node.textContent || '', 1200) === ctx.content) || null;
    }

    function scrollQuotedMessageToStart(target, margin = 18) {
      if (!target?.isConnected) return false;
      // A quote jump is an explicit user navigation action. Cancel every pending
      // tail/output-focus writer before changing scrollTop, otherwise a queued
      // layout settle can immediately pull the viewport back to the newest reply.
      try { deps.markManualMessageScroll?.({ type: 'quote-jump' }); } catch {}
      try { root.markManualMessageScroll?.({ type: 'quote-jump' }); } catch {}
      try { root.cancelSessionTailFocusAfterLayout?.(); } catch {}
      try { deps.cancelScrollTimer?.(); } catch {}
      try { root.ChatUIScrollDebug?.releaseBottomScrollLock?.({ bumpVersion: true, suppressMs: 2600 }); } catch {}
      try { root.ChatUIScrollDebug?.cleanupBottomScrollLock?.(); } catch {}
      const messages = deps.$?.('messages') || target.closest?.('#messages,.messages');
      if (!messages?.getBoundingClientRect) {
        target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        return true;
      }
      const applyScroll = () => {
        if (!target.isConnected) return;
        const messagesRect = messages.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top = Math.max(0, messages.scrollTop + targetRect.top - messagesRect.top - margin);
        if (typeof messages.scrollTo === 'function') messages.scrollTo({ top, behavior: 'auto' });
        else messages.scrollTop = top;
      };
      applyScroll();
      root.requestAnimationFrame?.(() => { applyScroll(); root.requestAnimationFrame?.(applyScroll); });
      [80, 180, 360].forEach(ms => root.setTimeout?.(applyScroll, ms));
      return true;
    }

    function jumpToQuotedMessage(quote) {
      const target = findQuotedMessageNode(quote);
      if (!target) return false;
      scrollQuotedMessageToStart(target, 18);
      target.classList.remove('quote-target-flash');
      void target.offsetWidth;
      target.classList.add('quote-target-flash');
      target.dataset.quoteFlash = String(Date.now());
      const clearFlash = () => { target.classList.remove('quote-target-flash'); delete target.dataset.quoteFlash; };
      target.addEventListener?.('animationend', clearFlash, { once: true });
      setTimeout(clearFlash, 3000);
      return true;
    }

    function bindSentQuotePreviews(root) {
      root?.querySelectorAll?.('.sent-quote-preview').forEach(button => {
        if (button.dataset.quoteJumpBound === '1') return;
        button.dataset.quoteJumpBound = '1';
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          jumpToQuotedMessage(button.dataset.quoteContext || '');
        });
      });
    }

    function getQuotedMessage() {
      const quote = deps.state?.quotedMessage || null;
      return quote?.content ? quote : null;
    }

    function renderComposerQuote() {
      const bar = deps.$?.('quoteBar');
      if (!bar) return;
      const quote = getQuotedMessage();
      if (!quote) {
        bar.hidden = true;
        bar.replaceChildren?.();
        if (!bar.replaceChildren) bar.innerHTML = '';
        return;
      }
      const label = deps.document?.createElement ? deps.document.createElement('span') : document.createElement('span');
      const text = deps.document?.createElement ? deps.document.createElement('span') : document.createElement('span');
      const close = deps.document?.createElement ? deps.document.createElement('button') : document.createElement('button');
      label.className = 'quote-preview-label';
      label.textContent = `引用 ${messageRoleLabel(quote.role)}`;
      text.className = 'quote-preview-text';
      text.textContent = normalizeQuoteText(quote.content, 180);
      close.className = 'quote-preview-close';
      close.type = 'button';
      close.title = '取消引用';
      close.setAttribute('aria-label', '取消引用');
      close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      close.addEventListener('click', clearQuotedMessage);
      bar.replaceChildren?.(label, text, close);
      if (!bar.replaceChildren) {
        bar.innerHTML = '';
        bar.append(label, text, close);
      }
      bar.hidden = false;
    }

    function clearQuotedMessage() {
      deps.state.quotedMessage = null;
      renderComposerQuote();
    }

    function activeSession() {
      const id = deps.state?.activeSessionId || '';
      return (deps.state?.sessions || []).find(session => session?.id === id) || null;
    }

    function displayItemForNode(node) {
      const session = activeSession();
      const display = Array.isArray(session?.display) ? session.display : [];
      const { displayItemId, responseIndex, messageIndex } = messageModel.resolveDisplayItemKey?.(node) || {
        displayItemId: node?.dataset?.displayItemId || node?.__displayItem?.id || '',
        responseIndex: node?.dataset?.responseIndex || node?.__displayItem?.responseIndex || '',
        messageIndex: node?.dataset?.messageIndex || node?.__displayItem?.messageIndex || '',
      };
      return node?.__displayItem
        || (displayItemId ? display.find(item => item?.id === displayItemId) : null)
        || (responseIndex !== '' ? display.find(item => item?.role === 'assistant' && String(item.responseIndex || '') === String(responseIndex)) : null)
        || (messageIndex !== '' ? display.find(item => item?.role === 'user' && String(item.messageIndex || '') === String(messageIndex)) : null)
        || null;
    }

    function canonicalMessageForNode(node, role = '') {
      const session = activeSession();
      const messages = Array.isArray(session?.messages) ? session.messages : Array.isArray(deps.state?.messages) ? deps.state.messages : [];
      const responseIndex = node?.dataset?.responseIndex || node?.__displayItem?.responseIndex || '';
      const messageIndex = node?.dataset?.messageIndex || node?.__displayItem?.messageIndex || '';
      if (role === 'assistant' && responseIndex !== '') {
        const message = messages[Number(responseIndex)];
        if (message?.role === 'assistant') return message;
      }
      if (role === 'user' && messageIndex !== '') {
        const message = messages[Number(messageIndex)];
        if (message?.role === 'user') return message;
      }
      return null;
    }

    const hasUsableImageContext = messageModel.hasUsableImageContext || (value => {
      if (!value) return false;
      try {
        const context = typeof value === 'string' ? JSON.parse(value) : value;
        return !!(context && typeof context === 'object' && Array.isArray(context.attachments) && context.attachments.length);
      } catch { return false; }
    });

    function quoteContentTextFromNode(node, displayItem, canonical) {
      const raw = node?.dataset?.rawText || displayItem?.rawText || canonical?.rawText || canonical?.content || '';
      if (String(raw || '').trim()) return raw;
      const contentNode = node?.querySelector?.('.content');
      if (contentNode) return contentNode.innerText || contentNode.textContent || '';
      const clone = node?.cloneNode?.(true);
      clone?.querySelectorAll?.('.reasoning-panel,.reasoning-head,.reasoning-content').forEach(item => item.remove());
      return clone?.textContent || '';
    }

    function resolveQuoteContextForNode(node) {
      if (!node) return null;
      const role = messageRoleFromNode(node);
      const displayItem = displayItemForNode(node);
      const canonical = canonicalMessageForNode(node, role);
      let imageContext = node.dataset.imageContext || displayItem?.imageContext || canonical?.imageContext || '';
      if (imageContext && !hasUsableImageContext(imageContext)) imageContext = '';
      if (!imageContext && typeof deps.getAssistantImageContext === 'function') {
        try {
          const assistantImageContext = deps.getAssistantImageContext(node);
          if (assistantImageContext) imageContext = typeof assistantImageContext === 'string' ? assistantImageContext : JSON.stringify(assistantImageContext);
        } catch {}
      }
      let attachmentContext = node.dataset.attachmentContext || displayItem?.attachmentContext || canonical?.attachmentContext || '';
      const content = role === 'assistant' && imageContext
        ? '[\u56fe\u7247\u6d88\u606f]'
        : normalizeQuoteText(quoteContentTextFromNode(node, displayItem, canonical));
      const quoteContent = content || (imageContext ? '[\u56fe\u7247\u6d88\u606f]' : attachmentContext ? '[\u9644\u4ef6\u6d88\u606f]' : '');
      if (!quoteContent && !imageContext && !attachmentContext) return null;
      if (imageContext && !node.dataset.imageContext) node.dataset.imageContext = imageContext;
      if (attachmentContext && !node.dataset.attachmentContext) node.dataset.attachmentContext = attachmentContext;
      const quote = { role: messageModel.normalizeRole?.(role, 'user') || (role === 'assistant' ? 'assistant' : 'user'), content: quoteContent, sessionId: deps.state.activeSessionId || '' };
      const displayItemId = node.dataset.displayItemId || displayItem?.id || canonical?.displayItemId || '';
      const messageIndex = node.dataset.messageIndex || displayItem?.messageIndex || canonical?.messageIndex || '';
      const responseIndex = node.dataset.responseIndex || displayItem?.responseIndex || canonical?.responseIndex || '';
      const canonicalId = String(canonical?.id || canonical?.messageId || canonical?.message_id || displayItem?.messageId || displayItem?.message_id || '');
      const indexedIdentity = role === 'assistant'
        ? (responseIndex !== '' ? `assistant:${responseIndex}` : '')
        : (messageIndex !== '' ? `user:${messageIndex}` : '');
      const quoteIdentity = String(displayItemId || canonicalId || indexedIdentity || '');
      if (displayItemId) quote.displayItemId = String(displayItemId);
      if (quoteIdentity) quote.id = quoteIdentity;
      if (messageIndex !== '') quote.messageIndex = String(messageIndex);
      if (responseIndex !== '') quote.responseIndex = String(responseIndex);
      if (imageContext) quote.imageContext = imageContext;
      if (attachmentContext) quote.attachmentContext = attachmentContext;
      return quote;
    }

    function selectQuotedMessage(node) {
      const quote = resolveQuoteContextForNode(node);
      if (!quote) return;
      deps.state.quotedMessage = quote;
      renderComposerQuote();
      deps.$?.('prompt')?.focus?.();
    }

    let markdownFinalRenderer = null;

    function getMarkdownFinalRenderer() {
      if (markdownFinalRenderer) return markdownFinalRenderer;
      const factory = getWorkflowModule('markdownFinalRenderer')?.createMarkdownFinalRenderer;
      if (!factory) throw new Error('markdownFinalRenderer 未加载');
      markdownFinalRenderer = factory({
        state: deps.state,
        document: deps.document || root.document,
        performance: root.performance,
        requestIdleCallback: root.requestIdleCallback?.bind?.(root),
        requestAnimationFrame: root.requestAnimationFrame?.bind?.(root),
        setTimeout: root.setTimeout?.bind?.(root),
        $: deps.$,
        getMessagesRoot: () => deps.$?.('messages'),
        renderMarkdown: deps.renderMarkdown,
        resetMessageActionStates: deps.resetMessageActionStates,
        bindInlineCopyButtons: deps.bindInlineCopyButtons,
        enhanceRenderedMarkdown: deps.enhanceRenderedMarkdown,
        hydrateMessageMedia: deps.hydrateMessageMedia,
        syncWebPreviews,
        cleanupGeneratedImageNumberArtifacts,
        shouldFollowScroll: deps.shouldFollowScroll,
        focusSessionTail: deps.focusSessionTail,
        preserveMessageBottomAnchor: deps.preserveMessageBottomAnchor,
      });
      return markdownFinalRenderer;
    }

    function renderMarkdownProgressively(messageNode, text = '', hash = chatuiContentHash(text)) {
      return getMarkdownFinalRenderer().renderProgressively(messageNode, text, hash);
    }

    function syncWebPreviews(messageNode, rawText = '') {
      if (!messageNode?.classList?.contains('assistant')) return 0;
      try {
        const preview = deps.webPreview || root?.ChatUIApp?.appContext?.getWorkflowModule?.('webPreview');
        return preview?.syncMessagePreviews?.(messageNode, rawText) || 0;
      } catch (err) {
        console.warn('[chatui] web preview sync failed', err);
        return 0;
      }
    }

    function createLiveMarkdownStream(messageNode, options = {}) {
      const factory = getWorkflowModule('markdownLiveStream')?.createMarkdownLiveStream;
      if (factory) return factory({
        renderMarkdown: deps.renderMarkdown,
        createStreamingRenderer: root.ChatUIApp?.markdown?.createStreamingRenderer,
        bindInlineCopyButtons: deps.bindInlineCopyButtons,
        enhanceRenderedMarkdown: deps.enhanceRenderedMarkdown,
        now: () => chatuiPerfNow(),
        onLayoutChange: () => commitLiveOutput(messageNode, { ...options, requireActive: true, requireFollow: true }),
      });
      return null;
    }

    function renderMarkdownPreviewSnapshot(contentNode, rawValue = '') {
      if (!contentNode) return false;
      const preview = getWorkflowModule('markdownPreview')?.renderMarkdownPreview;
      if (!preview) return renderPlainMarkdownSnapshot(contentNode, rawValue);
      contentNode.innerHTML = preview(String(rawValue || ''));
      contentNode.classList?.remove('markdown-stream-fallback-text');
      return true;
    }

    function renderPlainMarkdownSnapshot(contentNode, rawValue = '') {
      if (!contentNode) return false;
      const doc = deps.document || root.document;
      contentNode.textContent = String(rawValue || '');
      contentNode.classList?.add('markdown-stream-fallback-text');
      return !!doc;
    }

    function updateLiveMarkdownStream(messageNode, contentNode, rawValue = '', incoming = '', options = {}) {
      if (!messageNode || !contentNode) return false;
      let liveStream = messageNode.__markdownLiveStream;
      if (!liveStream) {
        liveStream = createLiveMarkdownStream(messageNode, options);
        messageNode.__markdownLiveStream = liveStream;
      }
      const next = String(rawValue || '');
      if (!liveStream) {
        contentNode.textContent = next || String(incoming || '');
        messageNode.dataset.streamingMarkdownMode = 'text-fallback';
        return false;
      }
      const result = liveStream.append(contentNode, next, { force: !messageNode.dataset.streamingMarkdownMode });
      messageNode.dataset.streamingMarkdownMode = 'incremental';
      messageNode.dataset.streamingMarkdownConsumed = String(result?.consumed ?? '');
      messageNode.dataset.streamingMarkdownTail = String(result?.tail?.length ?? 0);
      return true;
    }

    function updateMessage(e, t, s = {}) {
      with (deps) {
        if (void 0 !== s.messageIndex && null !== s.messageIndex) setDatasetValue(e, 'messageIndex', s.messageIndex);
        if (void 0 !== s.responseIndex && null !== s.responseIndex) setDatasetValue(e, 'responseIndex', s.responseIndex);
        const displayApi = root?.ChatUIAppDisplayItems || {};
        const canonicalRole = e.classList?.contains('user') ? 'user' : e.classList?.contains('assistant') || e.classList?.contains('error') ? 'assistant' : '';
        const canonicalIndex = canonicalRole === 'user' ? e.dataset.messageIndex : e.dataset.responseIndex;
        e = displayApi.reconcileCanonicalMessageNode?.($("messages"), e, { role: canonicalRole, index: canonicalIndex }) || e;
        const contentNode = e.querySelector(".content");
        const restore = s.noScroll ? (state.userScrollLocked ? preserveMessageViewport(e) : preserveMessageBottomAnchor(e, 72)) : null;
        const rawValue = String(s.rawText ?? t ?? "");
        const rawHash = chatuiContentHash(rawValue);
        const streamingFinalShouldPin = e === state.activeOutputNode && !state.userScrollLocked;
        const reconcileActionState = () => reconcileMessageActions(e, {
          state: s.actionState || (s.skipSave ? MESSAGE_ACTION_STATES.PENDING : MESSAGE_ACTION_STATES.READY),
          preservePersist: s.skipSave === true,
        });
        const canAutoFollowNow = () => !state.userScrollLocked && shouldFollowScroll();
        if (e.dataset.rawHash === rawHash && e.dataset.renderedHash === rawHash && e.dataset.enhancedHash === rawHash && !s.html && !s.metaText) {
          syncWebPreviews(e, rawValue);
          cleanupGeneratedImageNumberArtifacts(e);
          reconcileActionState();
          return;
        }

        let rendered = false;
        const largeAssistantMarkdown = !s.html && !e.classList?.contains("user") && shouldProgressiveRenderMarkdown(rawValue);
        if ((e.__markdownLiveStream?.final || e.__markdownStreamingRenderer?.final) && !s.html && !e.classList?.contains("user")) {
          try {
            if (largeAssistantMarkdown) {
              e.__markdownLiveStream?.dispose?.();
              e.__markdownStreamingRenderer?.dispose?.();
              rendered = !!renderMarkdownProgressively(e, rawValue, rawHash);
              e.dataset.markdownFinalMode = "progressive-canonical-final";
              delete e.dataset.markdownFinalEnhanced;
            } else if (e.__markdownLiveStream?.final) {
              const result = e.__markdownLiveStream.final(contentNode, rawValue);
              rendered = !!result;
              e.dataset.renderedHash = rawHash;
              if (result?.enhanced) e.dataset.enhancedHash = rawHash;
              e.dataset.markdownFinalEnhanced = result?.enhanced ? "1" : "";
              e.dataset.markdownFinalMode = result?.mode || "incremental-final";
              if (result?.reason) e.dataset.markdownFinalReason = result.reason;
              if (streamingFinalShouldPin && canAutoFollowNow()) pinActiveOutputToAnchor(e, { margin: 72 });
            } else {
              const result = e.__markdownStreamingRenderer.final(contentNode, rawValue);
              rendered = !!result;
              e.dataset.renderedHash = rawHash;
              if (result?.enhanced) e.dataset.enhancedHash = rawHash;
              e.dataset.markdownFinalEnhanced = result?.enhanced ? "1" : "";
              e.dataset.markdownFinalMode = result?.mode || "final";
              if (result?.reason) e.dataset.markdownFinalReason = result.reason;
              if (streamingFinalShouldPin && canAutoFollowNow()) pinActiveOutputToAnchor(e, { margin: 72 });
            }
          } catch {}
          delete e.__markdownLiveStream;
          delete e.__markdownStreamingRenderer;
        }
        if (!rendered && e.dataset.streamingMarkdownMode === "text-fallback" && largeAssistantMarkdown) {
          renderMarkdownProgressively(e, rawValue, rawHash);
          rendered = true;
          e.dataset.markdownFinalMode = "progressive-final";
        }
        delete e.dataset.streamingMarkdownMode;
        delete e.dataset.streamingMarkdownConsumed;
        delete e.dataset.streamingMarkdownTail;
        delete e.__lastStreamingRaw;
        delete e.dataset.lastStreamingRaw;
        delete e.__streamCanonicalPlacement;

        if (e === state.activeOutputNode && !s.skipSave) {
          state.streamFocusLocked = false;
          if (canAutoFollowNow()) pinActiveOutputToAnchor(e, { margin: 72 });
        }
        e.dataset.rawText = rawValue;
        e.dataset.rawHash = rawHash;
        reconcileActionState();
        if (void 0 !== s.messageIndex && null !== s.messageIndex) setDatasetValue(e, 'messageIndex', s.messageIndex);
        if (void 0 !== s.responseIndex && null !== s.responseIndex) setDatasetValue(e, 'responseIndex', s.responseIndex);

        if (!rendered) {
          if (s.html) {
            contentNode.innerHTML = s.preserveLiveMedia ? String(t || "") : stripTransientBlobUrlsFromHtml(t);
            e.dataset.renderedHash = rawHash;
            delete e.dataset.enhancedHash;
            if (e.classList?.contains('assistant') && e.querySelector?.('img.generated-thumb')) deps.moveImageActionsToMessageActions?.(e);
          } else if (chatuiShouldLazyRender(e.classList?.contains("user") ? "user" : "assistant", rawValue, { ...s, final: true }) && !chatuiIsNearViewport(e)) {
            chatuiQueueLazyMessage(e, rawValue);
          } else {
            const started = chatuiPerfNow();
            if (largeAssistantMarkdown) {
              renderMarkdownProgressively(e, rawValue, rawHash);
              rendered = true;
            } else {
              contentNode.innerHTML = e.classList?.contains("user") ? renderUserMessageContent(String(t || "")) : renderMarkdown(String(t || ""));
              e.dataset.renderedHash = rawHash;
            }
            delete e.dataset.enhancedHash;
            e.dataset.lazyMarkdown = "0";
            chatuiLogLongTask("message.update.renderMarkdown", chatuiPerfNow() - started, { chars: rawValue.length });
          }
        }

        cleanupGeneratedImageNumberArtifacts(e);
        if (void 0 !== s.metaText) setMessageMetaText(e, s.metaText);
        if ("1" !== e.dataset.markdownFinalEnhanced && e.dataset.lazyMarkdown !== "1" && e.dataset.enhancedHash !== rawHash && e.dataset.progressiveRendering !== "1") {
          bindInlineCopyButtons(e);
          enhanceRenderedMarkdown(e, { deferMermaid: true, allowResourceLoad: true, autoRenderMermaid: true, forceMermaid: true });
          cleanupGeneratedImageNumberArtifacts(e);
          hydrateMessageMedia(e, { save: true !== s.skipSave });
          e.dataset.enhancedHash = rawHash;
        }
        if (e.dataset.progressiveRendering !== '1') syncWebPreviews(e, rawValue);
        if (streamingFinalShouldPin && canAutoFollowNow()) {
          const pinFinal = () => { if (canAutoFollowNow()) pinActiveOutputToAnchor(e, { margin: 72 }); };
          requestAnimationFrame?.(pinFinal);
        }
        delete e.dataset.markdownFinalEnhanced;
        if (s.noScroll) {
          state.scrollVersion += 1;
          cancelScrollTimer();
          if (restore) { restore(); requestAnimationFrame(restore); setTimeout(restore, 80); }
          setTimeout(updateResumeStreamButton, 0);
        } else if (true === s.followActive || state.activeOutputNode === e) {
          if ((s.forceScroll ?? true === s.followActive) && canAutoFollowNow()) {
            if (false === s.settleScroll) {
              cancelScrollTimer();
              scrollToActiveOutput(e, { force: true, active: true, settle: false });
              cancelScrollTimer();
            } else scrollToActiveOutput(e, { force: true, active: true, settle: true });
          } else {
            state.activeOutputNode = e;
            state.scrollVersion += 1;
            cancelScrollTimer();
          }
        } else scrollToBottom(s.forceScroll ?? false);
      }
    }

    function updateMessageContentLight(e, t, s = {}) {
      with (deps) {
        if (shouldSuppressRunUi(s.sessionId || state.activeSessionId, s.runToken) || !e) return;
        if (void 0 !== s.messageIndex && null !== s.messageIndex) setDatasetValue(e, 'messageIndex', s.messageIndex);
        if (void 0 !== s.responseIndex && null !== s.responseIndex) setDatasetValue(e, 'responseIndex', s.responseIndex);
        const displayApi = root?.ChatUIAppDisplayItems || {};
        const canonicalRole = e?.classList?.contains('user') ? 'user' : e?.classList?.contains('assistant') || e?.classList?.contains('error') ? 'assistant' : '';
        const canonicalIndex = canonicalRole === 'user' ? e?.dataset?.messageIndex : e?.dataset?.responseIndex;
        const chatStream = s.streamKind === 'chat' && !s.html && !e.classList?.contains('user');
        const streamPlacementKey = chatStream && canonicalRole && canonicalIndex !== undefined && canonicalIndex !== null && canonicalIndex !== ''
          ? `${canonicalRole}:${canonicalIndex}`
          : '';
        // Canonical placement is a stream-start concern. Reconciliation walks
        // the whole message list and can move the live node; doing that for
        // every token turns an otherwise local content update into a mutation
        // of the entire history. Keep later deltas inside this message only.
        const alreadyPlaced = !!(streamPlacementKey
          && e.__streamCanonicalPlacement === streamPlacementKey
          && e.parentNode === $("messages"));
        if (!alreadyPlaced) e = displayApi.reconcileCanonicalMessageNode?.($("messages"), e, { role: canonicalRole, index: canonicalIndex }) || e;
        if (streamPlacementKey) e.__streamCanonicalPlacement = streamPlacementKey;
        const contentNode = e?.querySelector('.content');
        if (!contentNode) return;
        const rawValue = String(s.rawText ?? t ?? '');
        const rawHash = chatStream ? '' : chatuiContentHash(rawValue);
        if (!s.html && !chatStream && !e.classList?.contains('user') && e.dataset.rawHash === rawHash && e.dataset.renderedHash === rawHash && e.dataset.enhancedHash === rawHash && !s.forceRender) {
          cleanupGeneratedImageNumberArtifacts(e);
          return;
        }

        e.dataset.rawText = rawValue;
        if (chatStream) {
          e.__streamingRawLength = rawValue.length;
          if (!e.dataset.rawHash) e.dataset.rawHash = 'streaming';
          if (e.__lastStreamingRaw === rawValue) {
            updateResumeStreamButton();
            return;
          }
          e.__lastStreamingRaw = rawValue;
        } else {
          e.dataset.rawHash = rawHash;
          delete e.__streamingRawLength;
          delete e.__lastStreamingRaw;
        }
        const streamSessionId = s.sessionId || state.activeSessionId;
        const managesStreamingOutput = !!(chatStream && streamSessionId);
        if (managesStreamingOutput) {
          if (e.dataset.sessionId !== streamSessionId || state.activeOutputNode !== e) setActiveOutputForSession(streamSessionId, e);
          if (streamSessionId === state.activeSessionId && e.isConnected && !state.userScrollLocked && (!state.streamFocusLocked || s.forceStreamFocus)) {
            // Acquire stream-follow state now, but do not pin yet. The renderer
            // changes this message's height immediately below; pinning its old
            // geometry first and its new geometry in a RAF produces two visible
            // viewport positions and makes following messages flash.
            armStreamingOutputFocus(streamSessionId, e, {
              margin: 72,
              clearStaleFocus: !!s.clearStaleFocus,
              tailLock: s.tailLock === true,
              skipPin: true,
            });
          }
        }
        const restoreViewport = s.noScroll && !managesStreamingOutput ? (state.userScrollLocked ? preserveMessageViewport(e) : preserveMessageBottomAnchor(e, 72)) : null;
        setDatasetValue(e, 'streaming', '1');
        if (void 0 !== s.streamKind) setDatasetValue(e, 'streamKind', s.streamKind || '');
        if (void 0 !== s.runToken) setDatasetValue(e, 'streamRunToken', s.runToken || '');

        if (chatStream && shouldProgressiveRenderMarkdown(rawValue)) {
          delete e.__markdownStreamingRenderer;
          delete e.dataset.enhancedHash;
          updateLiveMarkdownStream(e, contentNode, rawValue, t, { sessionId: streamSessionId, tailLock: s.tailLock === true });
        } else if (chatStream) {
          delete e.dataset.enhancedHash;
          let streamRenderer = e.__markdownStreamingRenderer;
          if (!streamRenderer || s.resetStream) {
            streamRenderer = window.ChatUIApp?.markdown?.createStreamingRenderer?.({
              renderMarkdown,
              enhance: (scopeRoot, phase = {}) => {
                bindInlineCopyButtons(scopeRoot);
                enhanceRenderedMarkdown(scopeRoot, { streaming: !!phase.streaming, deferMermaid: true, allowResourceLoad: !!phase.final, autoRenderMermaid: !!phase.final, forceMermaid: !!phase.final });
              },
              onLayoutChange: () => commitLiveOutput(e, {
                tailLock: s.tailLock === true,
                sessionId: streamSessionId,
                requireActive: true,
                requireFollow: true,
              }),
            });
            e.__markdownStreamingRenderer = streamRenderer;
            contentNode.innerHTML = '';
          }
          if (streamRenderer && s.chunk !== false) {
            streamRenderer.set(rawValue, contentNode);
          } else if (contentNode.textContent !== rawValue) contentNode.textContent = rawValue;
        } else {
          const html = s.html ? String(t || '') : e.classList?.contains('user') ? renderUserMessageContent(rawValue) : renderMarkdown(rawValue);
          if (contentNode.innerHTML !== html) {
            contentNode.innerHTML = html;
            e.dataset.renderedHash = rawHash;
            delete e.dataset.enhancedHash;
            cleanupGeneratedImageNumberArtifacts(e);
            if (s.streamKind !== 'chat') {
              bindInlineCopyButtons(e);
              enhanceRenderedMarkdown(e, { allowResourceLoad: false });
              cleanupGeneratedImageNumberArtifacts(e);
              hydrateMessageMedia(e, { save: false });
              e.dataset.enhancedHash = rawHash;
            }
          }
          cleanupGeneratedImageNumberArtifacts(e);
        }

        if (restoreViewport) restoreViewport();
        else if (managesStreamingOutput) {
          if (!state.userScrollLocked && (s.forceScroll || shouldFollowScroll() || state.activeOutputNode === e)) {
            // This is deliberately synchronous with the stream renderer's DOM
            // mutation. A queued RAF allows the taller live message to paint
            // before compensation, then shifts every later message on the next
            // frame. One post-render end-anchor write keeps the lower history
            // visually stationary and is also the exact geometry used by the
            // “continue viewing output” action.
            commitLiveOutput(e, { tailLock: s.tailLock === true, sessionId: streamSessionId });
          }
        } else if (!s.noScroll && (s.forceScroll || shouldFollowScroll())) scrollToActiveOutput(e, { force: true, active: true, settle: false, margin: 72 });
        reconcileMessageActions(e, { state: MESSAGE_ACTION_STATES.PENDING });
        updateResumeStreamButton();
      }
    }

    function bindMobileMoreActions(node) {
      const actions = node?.querySelector?.('.msg-actions');
      const more = node?.querySelector?.('.mobile-more-btn');
      if (!actions || !more) return;
      if (actions.dataset.mobileMoreBound === '1') return;
      actions.dataset.mobileMoreBound = '1';
      more.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const expanded = actions.classList.toggle('is-mobile-open');
        more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
      actions.addEventListener('click', event => {
        if (event.target?.closest?.('.mobile-more-btn')) return;
        if (event.target?.closest?.('button')) {
          actions.classList.remove('is-mobile-open');
          more.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function resolveMessageActionHandler(name) {
      if (typeof deps?.[name] === 'function') return deps[name];
      if (typeof root?.[name] === 'function') return root[name];
      return null;
    }

    function bindMessageActions(node, role = 'assistant') {
      if (!node?.querySelector) return node;
      bindMobileMoreActions(node);
      const bind = (selector, handler, keep = true) => {
        const button = node.querySelector(selector);
        if (!button) return null;
        if (!keep) { button.remove(); return null; }
        if (button.dataset.messageActionBound !== '1') {
          button.dataset.messageActionBound = '1';
          button.addEventListener('click', handler);
        }
        return button;
      };
      const editUserMessage = resolveMessageActionHandler('editUserMessage');
      const forceImageFromUserMessage = resolveMessageActionHandler('forceImageFromUserMessage');
      const regenerateAssistantMessage = resolveMessageActionHandler('regenerateAssistantMessage');
      const copyText = resolveMessageActionHandler('copyText');
      const messageCopyText = resolveMessageActionHandler('messageCopyText');
      const showCopySuccess = resolveMessageActionHandler('showCopySuccess');
      const downloadAnswerFile = resolveMessageActionHandler('downloadAnswerFile');
      bind('.quote-btn', () => selectQuotedMessage(node));
      bind('.edit-btn', () => editUserMessage?.(node), role === 'user');
      bind('.force-image-btn', () => forceImageFromUserMessage?.(node), role === 'user');
      bind('.refresh-btn', () => regenerateAssistantMessage?.(node), role === 'assistant' || role === 'error');
      bind('.copy-btn', async () => {
        const content = node.querySelector('.content');
        const text = messageCopyText
          ? messageCopyText(node.dataset.rawText, content?.innerText || content?.textContent || '', content)
          : String(node.dataset.rawText || '');
        if (copyText) await copyText(text);
        showCopySuccess?.(node.querySelector('.copy-btn'));
      });
      const download = bind('.download-answer-btn', () => downloadAnswerFile?.(node, download), role === 'assistant' || role === 'error');
      return node;
    }

    // Every message lifecycle transition goes through this function. It repairs
    // missing action controls, binds them once, and applies the single pending/
    // ready visibility state. Image, chat, error, clarification and resume paths
    // must call this instead of mutating action visibility independently.
    function reconcileMessageActions(node, options = {}) {
      if (!node?.querySelector) return false;
      const role = messageActionRole(node);
      const actions = node.querySelector('.msg-actions');
      const template = deps.$ ? deps.$("messageTemplate") : root?.document?.getElementById?.("messageTemplate");
      const templateActions = template?.content?.querySelector?.('.msg-actions');
      if (actions && templateActions) {
        for (const templateButton of [...templateActions.children]) {
          const className = templateButton.classList?.[0];
          if (!className) continue;
          const button = actions.querySelector('.' + className) || templateButton.cloneNode(true);
          actions.appendChild(button);
        }
      }
      bindMessageActions(node, role);
      applyMessageActionLifecycle(node, options.state, deps.resetMessageActionStates, options);
      return true;
    }

    // Kept as the historical name for hydration callers; both names resolve to
    // the same reconciliation path above.
    function ensureMessageActions(node) {
      return reconcileMessageActions(node);
    }
    function addMessageProgressive(role, text, options = {}) {
      with (deps) {
        clearEmpty();
        const node = $("messageTemplate").content.firstElementChild.cloneNode(true);
        node.classList.add(role);
        node.querySelector(".avatar").textContent = role === "user" ? "我" : role === "error" ? "!" : "AI";
        const content = node.querySelector(".content");
        const rawText = options.rawText ?? text;
        const quote = quoteContextJson(options.quoteContext);
        node.dataset.rawText = rawText;
        node.dataset.rawHash = chatuiContentHash(rawText);
        if (quote) { node.dataset.quoteContext = quote; node.classList.add("has-quote"); }
        if (options.messageIndex !== undefined && options.messageIndex !== null) node.dataset.messageIndex = String(options.messageIndex);
        if (options.responseIndex !== undefined && options.responseIndex !== null) node.dataset.responseIndex = String(options.responseIndex);
        if (options.messageId) node.dataset.messageId = String(options.messageId);
        if (options.turnId) node.dataset.turnId = String(options.turnId);
        if (options.replyToMessageId) node.dataset.replyToMessageId = String(options.replyToMessageId);
        if (options.attachmentContext) node.dataset.attachmentContext = options.attachmentContext;
        if (options.imageContext) node.dataset.imageContext = options.imageContext;

        const lazy = chatuiShouldLazyRender(role, rawText, options);
        const progressive = !options.html && role === "assistant" && shouldProgressiveRenderMarkdown(rawText) && !options.deferEnhance;
        if (options.deferEnhance && role === "assistant" && !options.html) content.innerHTML = "";
        else if (options.html) content.innerHTML = role === "user" ? withSentQuotePreview(stripTransientBlobUrlsFromHtml(text), quote) : stripTransientBlobUrlsFromHtml(text);
        else if (progressive) renderMarkdownPreviewSnapshot(content, rawText);
        else if (lazy) content.innerHTML = chatuiPlainPreview(rawText);
        else content.innerHTML = role === "user" ? withSentQuotePreview(renderUserMessageContent(String(text || "")), quote) : renderMarkdown(String(text || ""));

        cleanupGeneratedImageNumberArtifacts(node);
        bindSentQuotePreviews(node);
        reconcileMessageActions(node, {
          state: role === 'assistant' ? (options.pending === true || options.skipSave === true ? MESSAGE_ACTION_STATES.PENDING : MESSAGE_ACTION_STATES.READY) : MESSAGE_ACTION_STATES.READY,
        });

        const messagesContainer = $("messages");
        const displayApi = root?.ChatUIAppDisplayItems || {};
        const canonicalIndex = role === "user" ? options.messageIndex : options.responseIndex;
        const hasCanonicalIndex = canonicalIndex !== undefined
          && canonicalIndex !== null
          && String(canonicalIndex).trim() !== ""
          && Number.isFinite(Number(canonicalIndex))
          && Number(canonicalIndex) >= 0;
        if (hasCanonicalIndex && typeof displayApi.insertMessageNodeAtDisplayPosition === "function") {
          displayApi.insertMessageNodeAtDisplayPosition(messagesContainer, node, {
            role,
            messageIndex: options.messageIndex,
            responseIndex: options.responseIndex,
          });
        }
        if (node.parentNode !== messagesContainer) messagesContainer.appendChild(node);
        if (progressive) renderMarkdownProgressively(node, String(rawText || ""), node.dataset.rawHash);
        else if (options.deferEnhance) {
          node.dataset.renderedHash = node.dataset.rawHash;
          node.dataset.deferEnhance = "1";
          bindInlineCopyButtons(node);
          cleanupGeneratedImageNumberArtifacts(node);
          hydrateMessageMedia(node, { save: !options.skipSave });
        } else if (lazy) chatuiQueueLazyMessage(node, rawText, { force: options.forceLazy });
        else {
          node.dataset.renderedHash = node.dataset.rawHash;
          bindInlineCopyButtons(node);
          enhanceRenderedMarkdown(node, { autoRenderMermaid: true, forceMermaid: true, deferMermaid: true, allowResourceLoad: true });
          cleanupGeneratedImageNumberArtifacts(node);
          hydrateMessageMedia(node, { save: !options.skipSave });
          bindSentQuotePreviews(node);
          node.dataset.enhancedHash = node.dataset.rawHash;
        }
        syncWebPreviews(node, String(rawText || ""));
        chatuiRefreshVirtualizer();
        setMessageMetaText(node, options.metaText || "");
        if (node.querySelector("img.generated-thumb") && !options.deferEnhance) revealNodeAboveComposer(node);
        if (!options.noScroll && !options.deferSave) scrollToBottom(true);
        if (!options.skipSave && !options.deferSave) saveDisplayHistory();
        return node;
      }
    }

    return Object.freeze({ updateMessage, updateMessageContentLight, addMessage: addMessageProgressive, reconcileMessageActions, ensureMessageActions, getQuotedMessage, clearQuotedMessage, selectQuotedMessage, resolveQuoteContextForNode, readQuoteContext, quoteContextJson, renderSentQuotePreview, withSentQuotePreview, jumpToQuotedMessage });
  }

  const api = Object.freeze({ createMessageWorkflow, reconcileCompletedMessageUi });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.ChatUIAppMessageWorkflow = api;
  }
  if (root?.window) root.window.ChatUIAppMessageWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
