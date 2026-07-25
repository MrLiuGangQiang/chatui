(function initChatUIHistoryAnchorNav(root) {
  const MIN_VISIBLE_ITEMS = 3;
  const RAIL_MAX_HEIGHT_PX = 520;
  const RAIL_VIEWPORT_RATIO = 0.66;
  const RAIL_PADDING_Y = 7;
  const RAIL_ROW_HEIGHT = 28;

  function normalizeQuestionTitle(value = '', limit = 56) {
    let text = String(value || '')
      .replace(/\r/g, '\n')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[[^\]\n]{0,40}\s+(?:id|name|type|size)=[^\]]*\]/gi, ' ')
      .replace(/data:[^\s]+/g, ' ')
      .replace(/[#>*_`|~-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) text = '用户问题';
    return text.length > limit ? `${text.slice(0, limit - 1).trim()}…` : text;
  }

  function userQuestionNodes(messagesRoot) {
    if (!messagesRoot?.querySelectorAll) return [];
    return [...messagesRoot.querySelectorAll('.message.user')].filter(node => node?.isConnected);
  }

  function makeUserNodeCache(messagesRoot, expectedCount = null) {
    const users = userQuestionNodes(messagesRoot);
    const byAnchorId = new Map();
    const byMessageIndex = new Map();
    users.forEach(node => {
      const anchorId = node?.dataset?.historyAnchorId || '';
      const messageIndex = node?.dataset?.messageIndex || '';
      if (anchorId && !byAnchorId.has(anchorId)) byAnchorId.set(anchorId, node);
      if (messageIndex && !byMessageIndex.has(messageIndex)) byMessageIndex.set(messageIndex, node);
    });
    return { users, byAnchorId, byMessageIndex, expectedCount };
  }

  function nodeQuestionText(node) {
    return node?.dataset?.rawText || node?.querySelector?.('.content')?.innerText || node?.textContent || '';
  }

  function ensureNodeAnchorId(node, index) {
    if (!node) return '';
    const existing = node.dataset.historyAnchorId;
    if (existing) return existing;
    const stable = node.dataset.displayItemId || node.dataset.messageIndex || `${Date.now()}-${index}`;
    const id = `chatui-question-anchor-${String(stable).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
    node.dataset.historyAnchorId = id;
    return id;
  }

  function createHistoryAnchorNav(options = {}) {
    const messages = options.messages;
    const nav = options.nav;
    const getItems = typeof options.getItems === 'function' ? options.getItems : null;
    const ensureItemNode = typeof options.ensureItemNode === 'function' ? options.ensureItemNode : null;
    const revealNode = typeof options.revealNode === 'function' ? options.revealNode : null;
    const markManualScroll = typeof options.markManualScroll === 'function' ? options.markManualScroll : null;
    const doc = options.document || root.document;
    if (!messages || !nav || !doc) return null;

    let signature = '';
    let scheduled = false;
    let activeId = '';
    let mutationObserver = null;
    let intersectionObserver = null;
    let expanded = false;
    let listEl = null;
    let toggleEl = null;
    let railEl = null;
    let countEl = null;
    let popupObserver = null;
    let currentItems = [];
    let jumpScrollToken = 0;
    let pinnedOpen = false;

    const clearJumpScrollSpace = () => {
      messages?.querySelector?.('.history-anchor-scroll-spacer')?.remove?.();
    };

    const cancelPendingJump = (options = {}) => {
      jumpScrollToken += 1;
      if (options.clearSpacer) clearJumpScrollSpace();
    };

    const setExpanded = (value, options = {}) => {
      expanded = !!value;
      if (Object.prototype.hasOwnProperty.call(options, 'pinned')) pinnedOpen = !!options.pinned;
      nav.classList.toggle('is-expanded', expanded);
      nav.classList.toggle('is-collapsed', !expanded);
      nav.classList.toggle('is-pinned', expanded && pinnedOpen);
      nav.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggleEl?.setAttribute?.('aria-expanded', expanded ? 'true' : 'false');
      toggleEl?.setAttribute?.('title', expanded ? (pinnedOpen ? '关闭目录' : '移开后收起目录') : '消息目录');
      toggleEl?.setAttribute?.('aria-label', expanded ? '收起历史问题目录' : '展开历史问题目录');
    };

    const isPopupOpen = () => {
      const body = doc.body;
      if (!body) return false;
      if (body.classList.contains('modal-open') || body.classList.contains('session-drawer-open')) return true;
      return !!doc.querySelector?.([
        '#configModal.show',
        '#imagePreview.show',
        '#reasoningMenu.show',
        '#sessionPromptPanel.show',
        '#sessionImageStylePanel.show',
        '#sessionModelPanel.show',
        '.confirm-dialog.show',
        '.custom-select.open',
        'body > .custom-select-menu.portal-menu',
      ].join(','));
    };

    const updatePopupVisibility = () => {
      const hidden = isPopupOpen();
      nav.classList.toggle('is-popup-hidden', hidden);
      if (hidden) setExpanded(false);
    };

    const railMaxHeight = () => {
      const viewportHeight = Number(root.innerHeight || doc.documentElement?.clientHeight || 0) || 800;
      return Math.max(140, Math.min(RAIL_MAX_HEIGHT_PX, Math.floor(viewportHeight * RAIL_VIEWPORT_RATIO)));
    };

    const railHeight = () => railMaxHeight();

    const updateRailMetrics = count => {
      if (!toggleEl || !railEl) return;
      const height = railHeight(count);
      nav.style.setProperty('--history-anchor-height', `${height}px`);
      nav.style.setProperty('--history-anchor-row-height', `${RAIL_ROW_HEIGHT}px`);
    };

    const updateRailAlignment = () => {
      if (!toggleEl || !railEl || !listEl) return;
      const panel = listEl.closest?.('.history-anchor-panel');
      const listStyle = root.getComputedStyle?.(listEl) || {};
      const paddingTop = parseFloat(listStyle.paddingTop || '0') || 0;
      const paddingBottom = parseFloat(listStyle.paddingBottom || '0') || 0;
      const toggleHeight = Number(toggleEl.offsetHeight || toggleEl.getBoundingClientRect?.().height || 0);
      const top = Math.max(0, Math.round(Number(panel?.offsetTop || 0) + Number(listEl.offsetTop || 0) - Number(toggleEl.offsetTop || 0) + paddingTop));
      const listViewportHeight = Math.max(0, Number(listEl.clientHeight || 0) - paddingTop - paddingBottom);
      const bottom = Math.max(0, Math.round(toggleHeight - top - listViewportHeight));
      nav.style.setProperty('--history-anchor-rail-offset', `${top}px`);
      nav.style.setProperty('--history-anchor-rail-bottom', `${bottom}px`);
    };

    const syncRailToList = () => {
      if (!railEl || !listEl) return;
      railEl.scrollTop = listEl.scrollTop;
    };

    const syncListToRail = () => {
      if (!railEl || !listEl) return;
      listEl.scrollTop = railEl.scrollTop;
    };

    const setHover = id => {
      nav.querySelectorAll?.('.history-anchor-item,.history-anchor-rail-bar').forEach(node => {
        node.classList.toggle('hover', !!id && node.dataset.anchorTarget === id);
      });
    };

    const offsetTopWithin = node => {
      const nodeRect = node.getBoundingClientRect?.();
      const messagesRect = messages.getBoundingClientRect?.();
      if (nodeRect && messagesRect) return messages.scrollTop + nodeRect.top - messagesRect.top;
      let top = 0;
      let current = node;
      while (current && current !== messages) {
        top += Number(current.offsetTop) || 0;
        current = current.offsetParent;
      }
      return top;
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      (root.requestAnimationFrame || root.setTimeout)(() => {
        scheduled = false;
        render();
      }, 0);
    };

    const setActive = id => {
      if (!id) return;
      activeId = id;
      let activeButton = null;
      let activeBar = null;
      nav.querySelectorAll?.('.history-anchor-item').forEach(button => {
        const active = button.dataset.anchorTarget === activeId;
        button.classList.toggle('active', active);
        if (active) {
          activeButton = button;
          button.setAttribute('aria-current', 'true');
          if (expanded) button.scrollIntoView?.({ block: 'nearest' });
        } else {
          button.removeAttribute('aria-current');
        }
      });
      nav.querySelectorAll?.('.history-anchor-rail-bar').forEach(bar => {
        const active = bar.dataset.anchorTarget === activeId;
        bar.classList.toggle('active', active);
        if (active) activeBar = bar;
      });
      if (expanded && activeButton) {
        (root.requestAnimationFrame || root.setTimeout)(syncRailToList, 0);
      } else {
        activeBar?.scrollIntoView?.({ block: 'nearest' });
        (root.requestAnimationFrame || root.setTimeout)(syncListToRail, 0);
      }
    };

    const observeActiveNodes = nodes => {
      intersectionObserver?.disconnect?.();
      if (!root.IntersectionObserver) return;
      intersectionObserver = new root.IntersectionObserver(entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top - messages.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - messages.getBoundingClientRect().top));
        const target = visible[0]?.target;
        if (target?.dataset?.historyAnchorId) setActive(target.dataset.historyAnchorId);
      }, { root: messages, threshold: [0.1, 0.35, 0.65], rootMargin: '-8% 0px -55% 0px' });
      nodes.forEach(node => intersectionObserver.observe(node));
    };

    const flashTarget = node => {
      node.classList.remove('history-anchor-target-flash');
      void node.offsetWidth;
      node.classList.add('history-anchor-target-flash');
      const clear = () => node.classList.remove('history-anchor-target-flash');
      node.addEventListener?.('animationend', clear, { once: true });
      root.setTimeout?.(clear, 1800);
    };

    const ensureJumpScrollSpace = (node, margin = 18) => {
      if (!messages || !node?.isConnected) return;
      let spacer = messages.querySelector?.('.history-anchor-scroll-spacer');
      if (!spacer) {
        spacer = doc.createElement('div');
        spacer.className = 'history-anchor-scroll-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        messages.appendChild(spacer);
      }
      const nodeHeight = node.getBoundingClientRect?.().height || node.offsetHeight || 0;
      const needed = Math.max(0, (messages.clientHeight || 0) - nodeHeight - margin * 2);
      spacer.style.height = `${Math.ceil(needed)}px`;
    };

    const isLastQuestionNode = node => {
      const users = userQuestionNodes(messages);
      return !!node && users.length > 0 && users[users.length - 1] === node;
    };

    const jumpToNode = node => {
      if (!node) return;
      cancelPendingJump({ clearSpacer: true });
      const pinLastQuestionToTop = isLastQuestionNode(node);
      const token = jumpScrollToken;
      try { markManualScroll?.({ type: 'history-anchor-nav', tailSpacer: pinLastQuestionToTop }); } catch {}
      try { root.cancelSessionTailFocusAfterLayout?.(); } catch {}
      try { root.cancelScrollTimer?.(); } catch {}
      try { root.ChatUIScrollDebug?.releaseBottomScrollLock?.({ bumpVersion: true, suppressMs: 2600 }); } catch {}
      try { root.ChatUIScrollDebug?.cleanupBottomScrollLock?.(); } catch {}
      if (messages) {
        if (pinLastQuestionToTop) ensureJumpScrollSpace(node, 18);
        const applyScroll = () => {
          if (token !== jumpScrollToken) return;
          if (!node.isConnected) return;
          if (!pinLastQuestionToTop) clearJumpScrollSpace();
          messages.scrollTop = Math.max(0, offsetTopWithin(node) - 18);
        };
        applyScroll();
        root.requestAnimationFrame?.(() => { applyScroll(); root.requestAnimationFrame?.(applyScroll); });
        [80, 180, 360, 720, 1200].forEach(ms => root.setTimeout?.(applyScroll, ms));
      } else if (revealNode) {
        revealNode(node, 18);
      } else {
        node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      }
      setActive(node.dataset.historyAnchorId || '');
      flashTarget(node);
    };

    const shouldRenderForMutation = mutations => {
      if (!Array.isArray(mutations)) return true;
      return mutations.some(mutation => {
        if (mutation.type === 'childList') return true;
        const target = mutation.target;
        if (!target?.classList?.contains('message') || !target.classList.contains('user')) return false;
        return ['data-raw-text', 'data-message-index', 'data-display-item-id'].includes(mutation.attributeName || '');
      });
    };

    const nodeForItem = (item, { ensure = false, cache = null } = {}) => {
      if (item?.node?.isConnected) return item.node;
      const id = String(item?.id || '');
      const messageIndex = String(item?.messageIndex ?? '');
      const userIndex = Number(item?.userIndex);
      const userCache = cache || makeUserNodeCache(messages);
      const visibleUsers = userCache.users;
      const expectedCount = Number.isFinite(userCache.expectedCount) ? userCache.expectedCount : currentItems.length;
      let node = messageIndex ? userCache.byMessageIndex.get(messageIndex) || null : null;
      if (!node && id) {
        node = userCache.byAnchorId.get(id) || null;
      }
      if (!node && Number.isFinite(userIndex) && visibleUsers.length === expectedCount) {
        node = visibleUsers[userIndex] || null;
      }
      if (!node && ensure) {
        try { node = ensureItemNode?.(item) || null; } catch { node = null; }
      }
      if (node && id) node.dataset.historyAnchorId = id;
      return node;
    };

    const ensureShell = () => {
      if (toggleEl && listEl) return;
      nav.replaceChildren?.();
      if (!nav.replaceChildren) nav.innerHTML = '';
      toggleEl = doc.createElement('button');
      toggleEl.type = 'button';
      toggleEl.className = 'history-anchor-toggle';
      toggleEl.setAttribute('aria-controls', 'historyAnchorList');
      railEl = doc.createElement('span');
      railEl.className = 'history-anchor-rail-bars';
      railEl.setAttribute('aria-hidden', 'true');
      toggleEl.appendChild(railEl);
      toggleEl.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const bar = event.target?.closest?.('.history-anchor-rail-bar');
        if (bar?.dataset?.anchorTarget) {
          const item = currentItems.find(item => item.id === bar.dataset.anchorTarget);
          jumpToNode(nodeForItem(item, { ensure: true }));
          return;
        }
        setExpanded(!expanded || !pinnedOpen, { pinned: !expanded || !pinnedOpen });
      });
      toggleEl.addEventListener('pointerover', event => {
        const bar = event.target?.closest?.('.history-anchor-rail-bar');
        setHover(bar?.dataset?.anchorTarget || '');
      });
      toggleEl.addEventListener('wheel', event => {
        if (!railEl || !listEl || railEl.scrollHeight <= railEl.clientHeight) return;
        event.preventDefault();
        railEl.scrollTop += event.deltaY;
        syncListToRail();
      }, { passive: false });
      nav.addEventListener('pointerenter', () => setExpanded(true));
      nav.addEventListener('pointerleave', () => { if (!pinnedOpen) setExpanded(false); setHover(''); });
      nav.addEventListener('focusin', () => setExpanded(true));
      nav.addEventListener('focusout', event => {
        if (!nav.contains(event.relatedTarget) && !pinnedOpen) { setExpanded(false); setHover(''); }
      });
      doc.addEventListener?.('click', event => {
        if (!pinnedOpen || nav.contains(event.target)) return;
        setExpanded(false, { pinned: false });
        setHover('');
      });
      const panel = doc.createElement('div');
      panel.className = 'history-anchor-panel';
      const head = doc.createElement('div');
      head.className = 'history-anchor-head';
      const title = doc.createElement('div');
      title.className = 'history-anchor-title';
      title.textContent = '消息目录';
      countEl = doc.createElement('div');
      countEl.className = 'history-anchor-count';
      head.append(title, countEl);
      listEl = doc.createElement('div');
      listEl.id = 'historyAnchorList';
      listEl.className = 'history-anchor-list';
      listEl.setAttribute('role', 'list');
      listEl.addEventListener('scroll', syncRailToList, { passive: true });
      panel.append(head, listEl);
      nav.append(toggleEl, panel);
    };

    const renderRail = items => {
      if (!railEl) return;
      updateRailMetrics(items.length);
      railEl.replaceChildren?.();
      if (!railEl.replaceChildren) railEl.innerHTML = '';
      items.forEach(item => {
        const bar = doc.createElement('span');
        bar.className = 'history-anchor-rail-bar';
        bar.dataset.anchorTarget = item.id;
        bar.title = item.title || '';
        if (item.id === activeId) bar.classList.add('active');
        railEl.appendChild(bar);
      });
      syncRailToList();
    };

    const render = () => {
      const fullItems = getItems?.() || null;
      const nodes = userQuestionNodes(messages);
      const userCache = makeUserNodeCache(messages, Array.isArray(fullItems) ? fullItems.length : nodes.length);
      const items = Array.isArray(fullItems) && fullItems.length
        ? fullItems.map((item, index) => {
          const node = nodeForItem(item, { ensure: false, cache: userCache });
          const id = item.id || ensureNodeAnchorId(node, index) || `chatui-question-anchor-full-${index}`;
          if (node) node.dataset.historyAnchorId = id;
          return { ...item, id, node, title: normalizeQuestionTitle(item.title || item.text || nodeQuestionText(node)) };
        })
        : nodes.map((node, index) => {
          const id = ensureNodeAnchorId(node, index);
          return { id, node, title: normalizeQuestionTitle(nodeQuestionText(node)) };
        });
      ensureShell();
      const nextSignature = items.map(item => `${item.id}:${item.title}`).join('|');
      if (nextSignature === signature) return;
      signature = nextSignature;
      currentItems = items;
      const visible = items.length >= MIN_VISIBLE_ITEMS;
      nav.classList.toggle('is-empty', !visible);
      nav.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (countEl) countEl.textContent = `${items.length} 条`;
      renderRail(items);
      listEl.replaceChildren?.();
      if (!listEl.replaceChildren) listEl.innerHTML = '';
      if (!visible) {
        activeId = '';
        intersectionObserver?.disconnect?.();
        return;
      }
      items.forEach(item => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'history-anchor-item';
        button.dataset.anchorTarget = item.id;
        button.title = item.title;
        button.setAttribute('role', 'listitem');
        button.setAttribute('aria-label', `定位到问题：${item.title}`);
        const text = doc.createElement('span');
        text.className = 'history-anchor-text';
        text.textContent = item.title;
        button.append(text);
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          jumpToNode(nodeForItem(item, { ensure: true }));
        });
        button.addEventListener('pointerenter', () => setHover(item.id));
        button.addEventListener('pointerleave', () => setHover(''));
        listEl.appendChild(button);
      });
      observeActiveNodes(items.map(item => nodeForItem(item, { ensure: false, cache: userCache })).filter(Boolean));
      updateRailAlignment();
      root.requestAnimationFrame?.(() => { updateRailAlignment(); syncRailToList(); });
      if (activeId) setActive(activeId);
      updatePopupVisibility();
    };

    const start = () => {
      ensureShell();
      setExpanded(false);
      mutationObserver?.disconnect?.();
      mutationObserver = new MutationObserver(mutations => {
        if (shouldRenderForMutation(mutations)) schedule();
      });
      mutationObserver.observe(messages, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-raw-text', 'data-message-index', 'data-display-item-id'] });
      popupObserver?.disconnect?.();
      popupObserver = new MutationObserver(() => (root.requestAnimationFrame || root.setTimeout)(updatePopupVisibility, 0));
      doc.body && popupObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-hidden', 'style'] });
      render();
    };

    const destroy = () => {
      mutationObserver?.disconnect?.();
      intersectionObserver?.disconnect?.();
      popupObserver?.disconnect?.();
    };

    return Object.freeze({ start, destroy, render, normalizeQuestionTitle, setExpanded, cancelPendingJump });
  }

  let instance = null;
  function init(options = {}) {
    if (instance) return instance;
    instance = createHistoryAnchorNav(options);
    instance?.start?.();
    return instance;
  }

  function cancelPendingJump(options = {}) {
    instance?.cancelPendingJump?.(options);
  }

  const api = Object.freeze({ init, createHistoryAnchorNav, normalizeQuestionTitle, cancelPendingJump });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const appContext = root?.ChatUIApp?.appContext;
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('historyAnchorNav', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
