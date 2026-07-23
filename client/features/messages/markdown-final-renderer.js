(function initChatUIFeaturesMessagesMarkdownFinalRenderer(root) {
  'use strict';

  function splitMarkdownRenderChunks(text = '') {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    // Markdown parsing is context-sensitive. Keep one canonical parse unit and
    // batch only the already-parsed top-level DOM nodes below.
    return [src];
  }

  function createMarkdownFinalRenderer(deps = {}) {
    const render = deps.renderMarkdown || (value => String(value || ''));
    const resetActions = deps.resetMessageActionStates || (() => {});
    const bindCopy = deps.bindInlineCopyButtons || (() => {});
    const enhance = deps.enhanceRenderedMarkdown || (() => {});
    const hydrate = deps.hydrateMessageMedia || (() => {});
    const cleanupGeneratedImageNumberArtifacts = deps.cleanupGeneratedImageNumberArtifacts || (() => {});
    const getMessagesRoot = deps.getMessagesRoot || (() => deps.$?.('messages'));
    const doc = deps.document || root.document;
    const scheduleIdle = deps.requestIdleCallback || root.requestIdleCallback;
    const delay = deps.setTimeout || root.setTimeout || ((fn) => { fn(); return 0; });
    const raf = deps.requestAnimationFrame || root.requestAnimationFrame;
    const perf = deps.performance || root.performance;

    function shouldAutoRefocusTail(messageNode) {
      return !!messageNode?.isConnected && !deps.state?.userScrollLocked && (deps.shouldFollowScroll?.() ?? true);
    }

    function messagesBottomGap() {
      const messagesRoot = getMessagesRoot();
      if (!messagesRoot) return 0;
      return Math.max(0, messagesRoot.scrollHeight - messagesRoot.scrollTop - messagesRoot.clientHeight);
    }

    function releaseFollowIfViewportMovedAway(threshold = 120) {
      if (messagesBottomGap() <= threshold || !deps.state) return false;
      deps.state.bottomScrollLocked = false;
      deps.state.userScrollLocked = true;
      deps.state.autoScrollLocked = false;
      deps.state.isAutoFollowing = false;
      deps.state.userScrolledAway = true;
      deps.state.lastUserScrollAt = Date.now();
      deps.state.outputPinSuppressUntil = Math.max(Number(deps.state.outputPinSuppressUntil) || 0, Date.now() + 1600);
      return true;
    }

    function preserveDistanceToBottom(bottomGap) {
      const messagesRoot = getMessagesRoot();
      if (!messagesRoot || !Number.isFinite(bottomGap)) return null;
      return () => {
        const target = Math.max(0, messagesRoot.scrollHeight - messagesRoot.clientHeight - bottomGap);
        messagesRoot.scrollTop = target;
        if (deps.state) deps.state.lastMessageScrollTop = messagesRoot.scrollTop;
      };
    }

    function refocusTailAfterMarkdownLayout(messageNode) {
      if (!shouldAutoRefocusTail(messageNode)) return;
      const messagesRoot = getMessagesRoot();
      if (!messagesRoot || messageNode !== [...messagesRoot.querySelectorAll?.('.message') || []].at(-1)) return;
      const run = () => {
        if (!shouldAutoRefocusTail(messageNode)) return;
        deps.state.autoScrollLocked = true;
        deps.state.programmaticScrollUntil = Math.max(Number(deps.state.programmaticScrollUntil) || 0, Date.now() + 900);
        try { deps.focusSessionTail?.({ margin: 18, threshold: 12 }); } catch {}
      };
      run();
      raf?.(run);
    }

    function renderProgressively(messageNode, text = '', hash = '') {
      const content = messageNode?.querySelector?.('.content');
      if (!content || !doc) return false;
      const token = Date.now() + ':' + Math.random().toString(36).slice(2);
      try { messageNode.__progressiveCleanup?.(); } catch {}
      messageNode.dataset.progressiveRenderToken = token;
      messageNode.dataset.progressiveRendering = '1';
      messageNode.dataset.progressiveOffscreen = '1';
      if (deps.state && shouldAutoRefocusTail(messageNode)) deps.state.programmaticScrollUntil = Math.max(Number(deps.state.programmaticScrollUntil) || 0, Date.now() + 1200);
      delete content.__plainStreamingTextNode;
      delete content.__plainStreamingBox;

      const body = doc.body || doc.documentElement;
      const contentWidth = Math.max(320, Math.ceil(content.getBoundingClientRect?.().width || content.clientWidth || messageNode.getBoundingClientRect?.().width || 720));
      const stageHost = doc.createElement('div');
      stageHost.className = messageNode.className || 'message assistant';
      stageHost.dataset.progressiveStage = '1';
      stageHost.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + contentWidth + 'px;max-width:' + contentWidth + 'px;visibility:hidden;pointer-events:none;z-index:-1;contain:layout style;';
      const stageContent = doc.createElement('div');
      stageContent.className = content.className || 'content';
      stageHost.appendChild(stageContent);
      body.appendChild(stageHost);

      let cleaned = false;
      const cleanupStage = () => {
        if (cleaned) return;
        cleaned = true;
        try { stageContent.__chatuiEnhanceJob?.cancel?.(); } catch {}
        try { stageHost.remove(); } catch {}
        if (messageNode.__progressiveCleanup === cleanupStage) delete messageNode.__progressiveCleanup;
      };
      messageNode.__progressiveCleanup = cleanupStage;

      const chunks = splitMarkdownRenderChunks(text);
      const nodeQueue = [];
      let chunkIndex = 0;
      let finishing = false;
      const isCurrent = () => messageNode.isConnected && messageNode.dataset.progressiveRenderToken === token;
      const schedule = () => {
        if (typeof scheduleIdle === 'function') scheduleIdle(run, { timeout: 80 });
        else delay(() => run(), 0);
      };
      const finish = async () => {
        if (finishing || !isCurrent()) return;
        finishing = true;
        try {
          resetActions(messageNode);
          cleanupGeneratedImageNumberArtifacts(stageContent);
          bindCopy(stageContent);
          const enhancePromise = enhance(stageContent, { deferMermaid: true, allowResourceLoad: true, autoRenderMermaid: true, forceMermaid: true });
          await Promise.resolve(enhancePromise).catch(() => []);
          if (!isCurrent()) return cleanupStage();
          hydrate(stageContent, { save: false });
          cleanupGeneratedImageNumberArtifacts(stageContent);
          const beforeReplaceBottomGap = messagesBottomGap();
          const movedAway = releaseFollowIfViewportMovedAway(120);
          const restoreMovedAwayGap = movedAway ? preserveDistanceToBottom(beforeReplaceBottomGap) : null;
          const shouldRefocus = !movedAway && shouldAutoRefocusTail(messageNode);
          const restoreProgressiveAnchor = shouldRefocus && deps.state?.activeOutputNode === messageNode
            ? deps.preserveMessageBottomAnchor?.(messageNode, 72)
            : null;
          content.replaceChildren(...[...stageContent.childNodes]);
          restoreMovedAwayGap?.();
          messageNode.dataset.renderedHash = hash;
          messageNode.dataset.enhancedHash = hash;
          delete messageNode.dataset.progressiveRendering;
          delete messageNode.dataset.progressiveOffscreen;
          cleanupGeneratedImageNumberArtifacts(messageNode);
          hydrate(messageNode, { save: false });
          deps.syncWebPreviews?.(messageNode, text);
          resetActions(messageNode);
          cleanupStage();
          if (movedAway) raf?.(() => restoreMovedAwayGap?.());
          if (shouldRefocus) {
            restoreProgressiveAnchor?.();
            refocusTailAfterMarkdownLayout(messageNode);
            Promise.resolve().then(() => refocusTailAfterMarkdownLayout(messageNode));
            raf?.(() => restoreProgressiveAnchor?.());
          }
        } catch (err) {
          console.warn('[chatui] progressive markdown offscreen render failed', err);
          if (isCurrent()) {
            content.innerHTML = render(text);
            messageNode.dataset.renderedHash = hash;
            delete messageNode.dataset.progressiveRendering;
            delete messageNode.dataset.progressiveOffscreen;
            try { bindCopy(messageNode); enhance(messageNode, { deferMermaid: true, allowResourceLoad: true, autoRenderMermaid: true, forceMermaid: true }); deps.syncWebPreviews?.(messageNode, text); } catch {}
          }
          cleanupStage();
        }
      };
      const run = deadline => {
        if (!isCurrent()) return cleanupStage();
        const started = perf?.now ? perf.now() : Date.now();
        const batch = [];
        while (true) {
          while (nodeQueue.length) {
            batch.push(nodeQueue.shift());
            const now = perf?.now ? perf.now() : Date.now();
            const timeLeft = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
            if (batch.length >= 48 || (now - started) > 10 || (timeLeft && timeLeft < 5)) break;
          }
          if (batch.length || chunkIndex >= chunks.length) break;
          const tpl = doc.createElement('template');
          tpl.innerHTML = render(chunks[chunkIndex++]);
          nodeQueue.push(...tpl.content.childNodes);
          const now = perf?.now ? perf.now() : Date.now();
          const timeLeft = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
          if ((now - started) > 10 || (timeLeft && timeLeft < 5)) break;
        }
        if (batch.length) stageContent.append(...batch);
        if (chunkIndex < chunks.length || nodeQueue.length) return schedule();
        finish();
      };
      schedule();
      return true;
    }

    return Object.freeze({ renderProgressively });
  }

  const api = Object.freeze({ createMarkdownFinalRenderer, splitMarkdownRenderChunks });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatUIFeaturesMessagesMarkdownFinalRenderer = api;
  if (root?.window) root.window.ChatUIFeaturesMessagesMarkdownFinalRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
