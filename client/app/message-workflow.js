(function initChatUIAppMessageWorkflow(root) {
  // Intentionally not strict: message rendering bodies are migrated from app.js and resolved through a deps scope.

  function createMessageWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

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
      return raw.length > 18000 || raw.split('\n').length > 420;
    }

    function splitMarkdownRenderChunks(text = '') {
      const src = String(text || '').replace(/\r\n?/g, '\n');
      const chunks = [];
      let buf = '', inFence = false, fenceChar = '', fenceLen = 0, inMath = false;
      const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
      for (const line of src.split(/(?<=\n)/)) {
        const rawLine = line.replace(/\n$/, '');
        const fence = rawLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (!inMath && fence) {
          const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim();
          if (inFence && ch === fenceChar && marker.length >= fenceLen && !info) {
            inFence = false; fenceChar = ''; fenceLen = 0; buf += line; flush(); continue;
          }
          if (!inFence) { inFence = true; fenceChar = ch; fenceLen = marker.length; }
          buf += line; continue;
        }
        if (!inFence && /^\s*\$\$\s*$/.test(rawLine)) {
          inMath = !inMath; buf += line; if (!inMath) flush(); continue;
        }
        buf += line;
        if (!inFence && !inMath && /^\s*$/.test(rawLine)) flush();
        if (!inFence && !inMath && buf.length > 8000) flush();
      }
      flush();
      return chunks.length ? chunks : [src];
    }

    function messageRoleLabel(role = '') {
      return role === 'user' ? '我' : role === 'assistant' ? 'AI' : '消息';
    }

    function messageRoleFromNode(node) {
      return node?.classList?.contains('assistant') ? 'assistant' : node?.classList?.contains('user') ? 'user' : 'error';
    }

    function normalizeQuoteText(text = '', limit = 1200) {
      return String(text || '')
        .replace(/\[base64 image\]/gi, '')
        .replace(/耗时：[^\n]+/g, '')
        .replace(/RT\s+[^\n]+/gi, '')
        .replace(/TTFT\s+[^\n]+/gi, '')
        .replace(/^\[图片(?:生成|编辑|修改)完成\]\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
    }

    function escapeHtmlLocal(value = '') {
      return String(value ?? '').replace(/[&<>\"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));
    }

    function readQuoteContext(value) {
      if (!value) return null;
      if (typeof value === 'string') {
        try { return readQuoteContext(JSON.parse(value)); } catch { return null; }
      }
      if (!value || typeof value !== 'object') return null;
      const hasImageContext = !!(value.imageContext || value.image_context);
      const content = normalizeQuoteText(value.content ?? value.rawText ?? (hasImageContext ? '[图片消息]' : ''), 1200);
      if (!content && !hasImageContext) return null;
      const quote = { role: value.role === 'assistant' ? 'assistant' : 'user', content: content || '[图片消息]' };
      ['sessionId', 'displayItemId', 'messageIndex', 'responseIndex', 'imageContext', 'attachmentContext'].forEach(key => {
        const altKey = key === 'imageContext' ? 'image_context' : key === 'attachmentContext' ? 'attachment_context' : key;
        const raw = value[key] ?? value[altKey];
        if (raw !== undefined && raw !== null && raw !== '') quote[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
      });
      return quote;
    }

    function quoteContextJson(value) {
      const quote = readQuoteContext(value);
      return quote ? JSON.stringify(quote) : '';
    }

    function renderSentQuotePreview(value) {
      const quote = readQuoteContext(value);
      if (!quote) return '';
      const label = quote.role === 'assistant' ? 'AI' : '用户';
      const context = escapeHtmlLocal(JSON.stringify(quote));
      const text = escapeHtmlLocal(normalizeQuoteText(quote.content, 48));
      return `<button class="sent-quote-preview" type="button" data-quote-context="${context}" title="jump to quoted message"><span class="sent-quote-label">&#24341;&#29992;</span><span class="sent-quote-text">${text}</span></button>`;
    }

    function withSentQuotePreview(html = '', quoteContext = '') {
      const preview = renderSentQuotePreview(quoteContext);
      if (!preview || /class=["'][^"']*sent-quote-preview/.test(String(html || ''))) return String(html || '');
      return `${preview}${String(html || '')}`;
    }

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

    function jumpToQuotedMessage(quote) {
      const target = findQuotedMessageNode(quote);
      if (!target) return false;
      if (!deps.revealNodeAboveComposer?.(target, 18)) target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      target.classList.remove('quote-target-flash');
      void target.offsetWidth;
      target.classList.add('quote-target-flash');
      const clearFlash = () => target.classList.remove('quote-target-flash');
      target.addEventListener?.('animationend', clearFlash, { once: true });
      setTimeout(clearFlash, 2800);
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
      deps.document?.querySelectorAll?.('.message.quoted')?.forEach(node => node.classList.remove('quoted'));
      renderComposerQuote();
    }

    function selectQuotedMessage(node) {
      if (!node) return;
      const role = messageRoleFromNode(node);
      let imageContext = node.dataset.imageContext || node.__displayItem?.imageContext || '';
      if (!imageContext && typeof deps.getAssistantImageContext === 'function') {
        try {
          const assistantImageContext = deps.getAssistantImageContext(node);
          if (assistantImageContext) imageContext = typeof assistantImageContext === 'string' ? assistantImageContext : JSON.stringify(assistantImageContext);
        } catch {}
      }
      if (imageContext && !node.dataset.imageContext) node.dataset.imageContext = imageContext;
      const content = normalizeQuoteText(node.dataset.rawText || node.querySelector?.('.content')?.innerText || node.textContent || '');
      const quoteContent = content || (imageContext ? '[图片消息]' : '');
      if (!quoteContent && !imageContext) return;
      deps.document?.querySelectorAll?.('.message.quoted')?.forEach(item => item.classList.remove('quoted'));
      node.classList.add('quoted');
      const quote = { role: role === 'assistant' ? 'assistant' : 'user', content: quoteContent, sessionId: deps.state.activeSessionId || '' };
      if (node.dataset.displayItemId) quote.displayItemId = node.dataset.displayItemId;
      if (node.dataset.messageIndex) quote.messageIndex = node.dataset.messageIndex;
      if (node.dataset.responseIndex) quote.responseIndex = node.dataset.responseIndex;
      const attachmentContext = node.dataset.attachmentContext || node.__displayItem?.attachmentContext || '';
      if (imageContext) quote.imageContext = imageContext;
      if (attachmentContext) quote.attachmentContext = attachmentContext;
      deps.state.quotedMessage = quote;
      renderComposerQuote();
      deps.$?.('prompt')?.focus?.();
    }

    function renderMarkdownProgressively(messageNode, text = '', hash = chatuiContentHash(text)) {
      const render = deps.renderMarkdown || (value => String(value || ''));
      const resetActions = deps.resetMessageActionStates || (() => {});
      const bindCopy = deps.bindInlineCopyButtons || (() => {});
      const enhance = deps.enhanceRenderedMarkdown || (() => {});
      const hydrate = deps.hydrateMessageMedia || (() => {});
      const content = messageNode?.querySelector?.('.content');
      if (!content) return false;
      const fragmentRootFor = nodes => ({
        querySelectorAll: selector => nodes.flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll(selector)] : []).filter(node => node.matches?.(selector)),
        querySelector: selector => nodes.find(node => node.nodeType === 1 && node.matches?.(selector)) || nodes.flatMap(node => node.nodeType === 1 ? [...node.querySelectorAll(selector)] : [])[0] || null,
      });
      const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      messageNode.dataset.progressiveRenderToken = token;
      messageNode.dataset.progressiveRendering = '1';
      delete content.__plainStreamingTextNode;
      delete content.__plainStreamingBox;
      const restoreProgressiveAnchor = deps.state?.activeOutputNode === messageNode && !deps.state?.userScrollLocked
        ? deps.preserveMessageBottomAnchor?.(messageNode, 72)
        : null;
      content.innerHTML = `<div class="markdown-progressive-status">正在分块挂载 Markdown…</div>`;
      restoreProgressiveAnchor?.();
      const tpl = document.createElement('template');
      tpl.innerHTML = render(text);
      const allNodes = [...tpl.content.childNodes];
      let index = 0;
      const run = deadline => {
        if (!messageNode.isConnected || messageNode.dataset.progressiveRenderToken !== token) return;
        const started = performance?.now ? performance.now() : Date.now();
        const batch = [];
        while (index < allNodes.length) {
          batch.push(allNodes[index++]);
          const now = performance?.now ? performance.now() : Date.now();
          const timeLeft = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
          if (batch.length >= 24 || (now - started) > 8 || (timeLeft && timeLeft < 5)) break;
        }
        content.querySelector('.markdown-progressive-status')?.remove();
        if (batch.length) {
          content.append(...batch);
          const chunkRoot = fragmentRootFor(batch);
          bindCopy(chunkRoot);
          enhance(chunkRoot, { deferMermaid: true, progressive: true, allowResourceLoad: true });
          restoreProgressiveAnchor?.();
        }
        if (index < allNodes.length) {
          if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 80 });
          else setTimeout(() => run(), 0);
          return;
        }
        delete messageNode.dataset.progressiveRendering;
        messageNode.dataset.renderedHash = hash;
        resetActions(messageNode);
        cleanupGeneratedImageNumberArtifacts(messageNode);
        hydrate(messageNode, { save: false });
        messageNode.dataset.enhancedHash = hash;
        restoreProgressiveAnchor?.();
        requestAnimationFrame?.(() => restoreProgressiveAnchor?.());
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 80 });
      else setTimeout(() => run(), 0);
      return true;
    }

    function updateMessage(e, t, s = {}) {
      with (deps) {
        const n=e.querySelector(".content"),a=s.noScroll?(state.userScrollLocked?preserveMessageViewport(e):preserveMessageBottomAnchor(e,72)):null,o=String(s.rawText??t??""),r=chatuiContentHash(o),streamingFinalShouldPin=e===state.activeOutputNode&&!state.userScrollLocked;if(e.dataset.rawHash===r&&e.dataset.renderedHash===r&&e.dataset.enhancedHash===r&&!s.html&&!s.metaText){cleanupGeneratedImageNumberArtifacts(e),delete e.dataset.streaming,delete e.dataset.streamKind,delete e.dataset.streamRunToken;return}let i=!1;if(e.__markdownStreamingRenderer?.final&&!s.html&&!e.classList?.contains("user")){try{const o=e.__markdownStreamingRenderer.final(n,String(s.rawText??t??""));i=!!o,e.dataset.renderedHash=r,o?.enhanced&&(e.dataset.enhancedHash=r),e.dataset.markdownFinalEnhanced=o?.enhanced?"1":"",e.dataset.markdownFinalMode=o?.mode||"final";o?.reason&&(e.dataset.markdownFinalReason=o.reason),streamingFinalShouldPin&&pinNodeBottomToTarget(e,{margin:72})}catch{}delete e.__markdownStreamingRenderer}if(delete e.dataset.streaming,delete e.dataset.streamKind,delete e.dataset.streamRunToken,e===state.activeOutputNode&&!s.skipSave&&(state.streamFocusLocked=!1,!state.userScrollLocked&&pinNodeBottomToTarget(e,{margin:72})),e.dataset.rawText=o,e.dataset.rawHash=r,s.skipSave?e.dataset.persist="0":delete e.dataset.persist,void 0!==s.messageIndex&&null!==s.messageIndex&&(e.dataset.messageIndex=String(s.messageIndex)),void 0!==s.responseIndex&&null!==s.responseIndex&&(e.dataset.responseIndex=String(s.responseIndex)),!i){if(s.html)n.innerHTML=stripTransientBlobUrlsFromHtml(t),e.dataset.renderedHash=r;else if(chatuiShouldLazyRender(e.classList?.contains("user")?"user":"assistant",o,{...s,final:!0})&&!chatuiIsNearViewport(e))chatuiQueueLazyMessage(e,o);else{const l=chatuiPerfNow();if(!e.classList?.contains("user")&&shouldProgressiveRenderMarkdown(o)){renderMarkdownProgressively(e,o,r)}else{n.innerHTML=e.classList?.contains("user")?renderUserMessageContent(String(t||"")):renderMarkdown(String(t||"")),e.dataset.renderedHash=r}delete e.dataset.enhancedHash,e.dataset.lazyMarkdown="0",chatuiLogLongTask("message.update.renderMarkdown",chatuiPerfNow()-l,{chars:o.length})}}cleanupGeneratedImageNumberArtifacts(e),resetMessageActionStates(e),void 0!==s.metaText&&setMessageMetaText(e,s.metaText);if("1"!==e.dataset.markdownFinalEnhanced&&e.dataset.lazyMarkdown!=="1"&&e.dataset.enhancedHash!==r&&e.dataset.progressiveRendering!=="1"){bindInlineCopyButtons(e),enhanceRenderedMarkdown(e,{deferMermaid:!0,allowResourceLoad:!0}),cleanupGeneratedImageNumberArtifacts(e),hydrateMessageMedia(e,{save:!0!==s.skipSave}),e.dataset.enhancedHash=r}if(streamingFinalShouldPin){const pinFinal=()=>pinNodeBottomToTarget(e,{margin:72});requestAnimationFrame?.(pinFinal),setTimeout(pinFinal,120),setTimeout(pinFinal,420)}delete e.dataset.markdownFinalEnhanced,s.noScroll?(state.scrollVersion+=1,cancelScrollTimer(),a&&(a(),requestAnimationFrame(a),setTimeout(a,80)),setTimeout(updateResumeStreamButton,0)):!0===s.followActive||state.activeOutputNode===e?s.forceScroll??!0===s.followActive?!1===s.settleScroll?(cancelScrollTimer(),scrollToActiveOutput(e,{force:!0,active:!0,settle:!1}),cancelScrollTimer()):scrollToActiveOutput(e,{force:!0,active:!0,settle:!0}):(state.activeOutputNode=e,state.scrollVersion+=1,cancelScrollTimer()):scrollToBottom(s.forceScroll??!1)
      }
    }

    function updateMessageContentLight(e, t, s = {}) {
      with (deps) {
        if(shouldSuppressRunUi(s.sessionId||state.activeSessionId,s.runToken))return;const n=e?.querySelector(".content");if(!n)return;const l=String(s.rawText??t??""),d=chatuiContentHash(l);if(!s.html&&"chat"!==s.streamKind&&!e.classList?.contains("user")&&e.dataset.rawHash===d&&e.dataset.renderedHash===d&&e.dataset.enhancedHash===d&&!s.forceRender){cleanupGeneratedImageNumberArtifacts(e);return}const o=s.noScroll?(state.userScrollLocked?preserveMessageViewport(e):preserveMessageBottomAnchor(e,72)):null,a=l;e.dataset.rawText=a,e.dataset.rawHash=d,e.dataset.streaming="1",void 0!==s.streamKind&&(e.dataset.streamKind=s.streamKind||""),void 0!==s.runToken&&(e.dataset.streamRunToken=s.runToken||""),s.skipSave&&(e.dataset.persist="0");if("chat"===s.streamKind&&!s.html&&!e.classList?.contains("user")){delete e.dataset.enhancedHash;let r=e.__markdownStreamingRenderer;if(!r||s.resetStream){r=window.ChatUIApp?.markdown?.createStreamingRenderer?.({renderMarkdown,enhance:(root,phase={})=>{bindInlineCopyButtons(root);enhanceRenderedMarkdown(root,{skipMermaid:!0,streaming:!!phase.streaming,deferMermaid:!0,allowResourceLoad:!!phase.final})}}),e.__markdownStreamingRenderer=r,n.innerHTML=""}if(r&&s.chunk!==!1){const l=String(t??"");const d=s.delta?l:l.startsWith(r.getRaw?.()||"")?l.slice((r.getRaw?.()||"").length):a.startsWith(r.getRaw?.()||"")?a.slice((r.getRaw?.()||"").length):l;r.append(d,n)}else if(n.textContent!==a)n.textContent=a}else{const i=s.html?String(t||""):e.classList?.contains("user")?renderUserMessageContent(a):renderMarkdown(a);n.innerHTML!==i&&(n.innerHTML=i,e.dataset.renderedHash=d,delete e.dataset.enhancedHash,resetMessageActionStates(e),cleanupGeneratedImageNumberArtifacts(e),"chat"!==s.streamKind&&(bindInlineCopyButtons(e),enhanceRenderedMarkdown(e,{allowResourceLoad:!1}),cleanupGeneratedImageNumberArtifacts(e),hydrateMessageMedia(e,{save:!1}),e.dataset.enhancedHash=d))}cleanupGeneratedImageNumberArtifacts(e);if(s.noScroll)o&&o();else scrollToActiveOutput(e,{force:!0,active:!0,settle:!1,margin:72});setTimeout(updateResumeStreamButton,0)
      }
    }

    function addMessage(e, t, s = {}) {
      with (deps) {
        clearEmpty();const n=$("messageTemplate").content.firstElementChild.cloneNode(!0);n.classList.add(e),n.querySelector(".avatar").textContent="user"===e?"我":"error"===e?"!":"AI";const a=n.querySelector(".content"),i=s.rawText??t,q=quoteContextJson(s.quoteContext);n.dataset.rawText=i,n.dataset.rawHash=chatuiContentHash(i),q&&(n.dataset.quoteContext=q,n.classList.add("has-quote")),s.skipSave&&(n.dataset.persist="0"),void 0!==s.messageIndex&&null!==s.messageIndex&&(n.dataset.messageIndex=String(s.messageIndex)),void 0!==s.responseIndex&&null!==s.responseIndex&&(n.dataset.responseIndex=String(s.responseIndex)),s.attachmentContext&&(n.dataset.attachmentContext=s.attachmentContext),s.imageContext&&(n.dataset.imageContext=s.imageContext);const o=chatuiShouldLazyRender(e,i,s);s.deferEnhance&&"assistant"===e&&!s.html?a.innerHTML="":s.html?a.innerHTML=("user"===e?withSentQuotePreview(stripTransientBlobUrlsFromHtml(t),q):stripTransientBlobUrlsFromHtml(t)):o?a.innerHTML=chatuiPlainPreview(i):a.innerHTML="user"===e?withSentQuotePreview(renderUserMessageContent(String(t||"")),q):renderMarkdown(String(t||""));cleanupGeneratedImageNumberArtifacts(n);bindSentQuotePreviews(n);n.querySelector(".quote-btn")?.addEventListener("click",()=>selectQuotedMessage(n));const r=n.querySelector(".edit-btn");"user"===e?r.addEventListener("click",()=>editUserMessage(n)):r.remove();const l=n.querySelector(".refresh-btn");"assistant"===e||"error"===e?l.addEventListener("click",()=>regenerateAssistantMessage(n)):l.remove(),n.querySelector(".copy-btn")?.addEventListener("click",async()=>{await copyText(messageCopyText(n.dataset.rawText,a.innerText||a.textContent||"",a)),showCopySuccess(n.querySelector(".copy-btn"))});const d=n.querySelector(".download-answer-btn");return"assistant"===e?d?.addEventListener("click",()=>downloadAnswerFile(n,d)):d?.remove(),$("messages").appendChild(n),s.deferEnhance?(n.dataset.renderedHash=n.dataset.rawHash,n.dataset.deferEnhance="1",bindInlineCopyButtons(n),cleanupGeneratedImageNumberArtifacts(n),hydrateMessageMedia(n,{save:!s.skipSave})):o?chatuiQueueLazyMessage(n,i,{force:s.forceLazy}):(n.dataset.renderedHash=n.dataset.rawHash,bindInlineCopyButtons(n),enhanceRenderedMarkdown(n,{skipMermaid:!0,allowResourceLoad:!0}),cleanupGeneratedImageNumberArtifacts(n),hydrateMessageMedia(n,{save:!s.skipSave}),bindSentQuotePreviews(n),n.dataset.enhancedHash=n.dataset.rawHash),chatuiRefreshVirtualizer(),setMessageMetaText(n,s.metaText||""),n.querySelector("img.generated-thumb")&&!s.deferEnhance&&revealNodeAboveComposer(n),s.noScroll||s.deferSave||scrollToBottom(!0),s.skipSave||s.deferSave||saveDisplayHistory(),n
      }
    }

    return Object.freeze({ updateMessage, updateMessageContentLight, addMessage, getQuotedMessage, clearQuotedMessage, selectQuotedMessage, readQuoteContext, quoteContextJson, renderSentQuotePreview, withSentQuotePreview, jumpToQuotedMessage });
  }

  const api = Object.freeze({ createMessageWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppMessageWorkflow = api;
  if (root?.window) root.window.ChatUIAppMessageWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
