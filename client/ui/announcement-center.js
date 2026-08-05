(function initAnnouncementCenter(root) {
  'use strict';

  const READ_ANNOUNCEMENTS_KEY = 'chatui-announcements-read-v1';
  const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

  function announcementMarkdown(body = '') {
    return String(body || '').replace(/^#\s+.*(?:\r?\n|$)/, '').trim();
  }

  function createAnnouncementCenterController(options = {}) {
    const documentRef = options.document || root?.document;
    const fetchImpl = options.fetchImpl || root?.fetch?.bind(root);
    const storage = options.storage || root?.localStorage;
    const markdownRenderer = options.renderMarkdown
      || root?.ChatUIMarkdown?.renderMarkdown
      || root?.ChatUIApp?.markdown?.renderMarkdown;
    const requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
      ? Math.max(0, Number(options.requestTimeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const AbortControllerImpl = options.AbortController
      || root?.AbortController
      || (typeof AbortController !== 'undefined' ? AbortController : null);
    const getElement = id => documentRef?.getElementById(id);
    let announcements = [];
    let active = true;
    let forced = true;
    let initialized = false;
    let previousFocus = null;
    let loadingPromise = null;

    function readAcknowledgedVersions() {
      try {
        const value = JSON.parse(storage?.getItem(READ_ANNOUNCEMENTS_KEY) || '[]');
        return new Set(Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : []);
      } catch {
        return new Set();
      }
    }

    function writeAcknowledgedVersions(versions = []) {
      const current = readAcknowledgedVersions();
      versions.map(item => String(item || '').trim()).filter(Boolean).forEach(version => current.add(version));
      try { storage?.setItem(READ_ANNOUNCEMENTS_KEY, JSON.stringify([...current])); } catch {}
      return current;
    }

    function latestAnnouncement() {
      return announcements[0] || null;
    }

    function latestIsUnread() {
      const latest = latestAnnouncement();
      return !!latest && !readAcknowledgedVersions().has(String(latest.version || '').trim());
    }

    function appShell() {
      return documentRef?.querySelector?.('[data-announcement-app]') || documentRef?.querySelector?.('.shell-app');
    }

    function acknowledgedBootIsActive() {
      return !!documentRef?.documentElement?.classList?.contains('announcement-acknowledged-boot');
    }

    function clearAcknowledgedBoot() {
      documentRef?.documentElement?.classList?.remove('announcement-acknowledged-boot');
    }

    function setApplicationLocked(locked) {
      const shell = appShell();
      documentRef?.body?.classList.toggle('announcement-locked', locked);
      documentRef?.body?.classList.remove('announcement-pending');
      if (!shell) return;
      if (locked) {
        try { shell.inert = true; } catch {}
        shell.setAttribute('inert', '');
        shell.setAttribute('aria-hidden', 'true');
      } else {
        try { shell.inert = false; } catch {}
        shell.removeAttribute('inert');
        shell.removeAttribute('aria-hidden');
      }
    }

    function syncLaunchers() {
      const unread = latestIsUnread();
      documentRef?.querySelectorAll?.('[data-announcement-open]')?.forEach(node => {
        node.classList.toggle('has-unread-announcement', unread);
        node.setAttribute('data-unread-announcement', unread ? '1' : '0');
        node.setAttribute('aria-label', unread ? '查看公告，有未读重要公告' : '查看公告');
        node.setAttribute('title', unread ? '重要公告（未读）' : '公告中心');
      });
    }

    function setOpen(open, { force = forced, focus = true } = {}) {
      const modal = getElement('announcementModal');
      if (!modal) return false;
      active = !!open;
      forced = !!force && !!open;
      modal.classList.toggle('show', active);
      modal.classList.toggle('is-forced', forced);
      modal.setAttribute('aria-hidden', active ? 'false' : 'true');
      getElement('closeAnnouncementBtn')?.toggleAttribute?.('hidden', !active || forced);
      getElement('acknowledgeAnnouncementBtn')?.classList.toggle('is-forced-action', forced);
      if (active) documentRef?.body?.classList.add('modal-open');
      else documentRef?.body?.classList.remove('modal-open');
      setApplicationLocked(forced);
      if (active && focus) {
        const target = forced ? getElement('acknowledgeAnnouncementBtn') : getElement('closeAnnouncementBtn');
        (target && !target.disabled ? target : modal.querySelector?.('.announcement-dialog'))?.focus?.({ preventScroll: true });
      } else if (!active) {
        previousFocus?.focus?.({ preventScroll: true });
      }
      return true;
    }

    function wrapTables(container) {
      container?.querySelectorAll?.('table')?.forEach(table => {
        if (table.parentElement?.classList.contains('announcement-table-wrap')) return;
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'announcement-table-wrap';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      });
    }

    function renderMarkdown(container, source = '') {
      if (!container) return;
      const markdown = announcementMarkdown(source);
      if (typeof markdownRenderer === 'function') container.innerHTML = markdownRenderer(markdown);
      else container.textContent = markdown;
      wrapTables(container);
    }

    function createHistoryEntry(announcement, index) {
      const entry = documentRef.createElement('details');
      entry.className = 'announcement-history-entry';
      const summary = documentRef.createElement('summary');
      summary.className = 'announcement-history-summary';
      const copy = documentRef.createElement('span');
      copy.className = 'announcement-history-copy';
      const version = documentRef.createElement('strong');
      version.textContent = String(announcement.version || `历史公告 ${index + 1}`);
      const title = documentRef.createElement('span');
      title.textContent = String(announcement.title || '历史公告');
      copy.append(version, title);
      const date = documentRef.createElement('time');
      date.textContent = String(announcement.publishedAt || '');
      if (announcement.publishedAt) date.dateTime = announcement.publishedAt;
      const chevron = documentRef.createElement('span');
      chevron.className = 'announcement-history-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      summary.append(copy, date, chevron);
      const body = documentRef.createElement('div');
      body.className = 'announcement-history-body markdown-body';
      const ensureBody = () => {
        if (!entry.open || body.dataset.rendered === '1') return;
        body.dataset.rendered = '1';
        renderMarkdown(body, announcement.body);
      };
      entry.addEventListener('toggle', ensureBody);
      entry.append(summary, body);
      return entry;
    }

    function renderHistory() {
      const panel = getElement('announcementHistoryPanel');
      const list = getElement('announcementHistoryList');
      const button = getElement('announcementHistoryBtn');
      if (!panel || !list || !button) return;
      list.textContent = '';
      const history = announcements.slice(1);
      button.hidden = history.length === 0;
      button.textContent = history.length ? `查看历史公告（${history.length}）` : '暂无历史公告';
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      history.forEach((announcement, index) => list.appendChild(createHistoryEntry(announcement, index)));
    }

    function renderLatest() {
      const latest = latestAnnouncement();
      const latestPanel = getElement('announcementLatest');
      const status = getElement('announcementStatus');
      const acknowledge = getElement('acknowledgeAnnouncementBtn');
      if (!latest) {
        latestPanel?.setAttribute('hidden', '');
        if (status) {
          status.hidden = false;
          status.className = 'announcement-status';
          status.textContent = '暂无公告';
        }
        if (acknowledge) acknowledge.disabled = true;
        renderHistory();
        syncLaunchers();
        return;
      }

      latestPanel?.removeAttribute('hidden');
      if (status) status.hidden = true;
      const badge = getElement('announcementBadge');
      const version = getElement('announcementVersion');
      const publishedAt = getElement('announcementPublishedAt');
      const title = getElement('announcementTitle');
      const summary = getElement('announcementSummary');
      if (badge) badge.textContent = String(latest.badge || '系统公告');
      if (version) version.textContent = String(latest.version || '');
      if (publishedAt) {
        publishedAt.textContent = String(latest.publishedAt || '');
        publishedAt.toggleAttribute('hidden', !latest.publishedAt);
        if (latest.publishedAt) publishedAt.dateTime = latest.publishedAt;
      }
      if (title) title.textContent = String(latest.title || '最新公告');
      if (summary) {
        summary.textContent = String(latest.summary || '');
        summary.toggleAttribute('hidden', !latest.summary);
      }
      renderMarkdown(getElement('announcementBody'), latest.body);
      if (acknowledge) {
        acknowledge.disabled = false;
        acknowledge.textContent = latestIsUnread() ? '我已阅读，进入 ChatUI' : '关闭公告';
      }
      renderHistory();
      syncLaunchers();
    }

    function showLoading() {
      const modal = getElement('announcementModal');
      const status = getElement('announcementStatus');
      modal?.classList.add('is-loading');
      getElement('announcementLatest')?.setAttribute('hidden', '');
      getElement('announcementHistoryPanel')?.setAttribute('hidden', '');
      if (status) {
        status.hidden = false;
        status.className = 'announcement-status is-loading';
        status.replaceChildren();
        const pulse = documentRef.createElement('span');
        pulse.className = 'announcement-loading-mark';
        pulse.setAttribute('aria-hidden', 'true');
        const text = documentRef.createElement('span');
        text.textContent = '正在获取最新公告…';
        status.append(pulse, text);
      }
      const acknowledge = getElement('acknowledgeAnnouncementBtn');
      if (acknowledge) acknowledge.disabled = true;
    }

    function showLoadFailure() {
      clearAcknowledgedBoot();
      const modal = getElement('announcementModal');
      const status = getElement('announcementStatus');
      modal?.classList.remove('is-loading');
      if (!status) return;
      status.hidden = false;
      status.className = 'announcement-status is-error';
      status.replaceChildren();
      const title = documentRef.createElement('strong');
      title.textContent = '公告加载失败';
      const copy = documentRef.createElement('span');
      copy.textContent = '为避免遗漏重要通知，公告加载成功前暂时无法使用其他功能。';
      const retry = documentRef.createElement('button');
      retry.type = 'button';
      retry.className = 'announcement-retry-btn';
      retry.textContent = '重新加载';
      retry.addEventListener('click', () => void load({ initial: true, forceReload: true }));
      status.append(title, copy, retry);
      setOpen(true, { force: true });
      retry.focus?.({ preventScroll: true });
    }

    async function fetchAnnouncements() {
      let timer = null;
      let controller = null;
      try {
        controller = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null;
        const requestOptions = { cache: 'no-store' };
        if (controller) requestOptions.signal = controller.signal;
        const request = Promise.resolve(fetchImpl('/api/announcements', requestOptions));
        if (!(requestTimeoutMs > 0)) return await request;
        const timeout = new Promise((_, reject) => {
          timer = (root?.setTimeout || setTimeout)(() => {
            try { controller?.abort?.(); } catch {}
            reject(new Error(`公告请求超时（${requestTimeoutMs}ms）`));
          }, requestTimeoutMs);
        });
        return await Promise.race([request, timeout]);
      } finally {
        if (timer !== null) (root?.clearTimeout || clearTimeout)(timer);
      }
    }

    async function load({ initial = false, forceReload = false } = {}) {
      if (loadingPromise) return loadingPromise;
      if (!fetchImpl) {
        showLoadFailure();
        return [];
      }
      // Background refreshes must not blank an already-rendered announcement. A
      // focus/pageshow/visibility event can fire repeatedly while the page is
      // being used; showing the initial loading shell for each refresh made the
      // dialog look permanently stuck on “正在获取最新公告”.
      const hasRenderedAnnouncements = initialized && announcements.length > 0;
      if (!hasRenderedAnnouncements) showLoading();
      loadingPromise = (async () => {
        try {
          const response = await fetchAnnouncements();
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          announcements = Array.isArray(payload?.announcements) ? payload.announcements : [];
          clearAcknowledgedBoot();
          getElement('announcementModal')?.classList.remove('is-loading');
          renderLatest();
          initialized = true;
          if (latestIsUnread()) setOpen(true, { force: true });
          else if (initial) setOpen(false, { force: false, focus: false });
          return announcements;
        } catch (error) {
          if (!hasRenderedAnnouncements) {
            initialized = false;
            showLoadFailure();
          }
          throw error;
        } finally {
          loadingPromise = null;
        }
      })();
      loadingPromise.catch(() => {});
      return loadingPromise;
    }

    async function initialize() {
      if (acknowledgedBootIsActive()) {
        // The synchronous head bootstrap already knows this browser has read at
        // least one announcement. Keep the app inert while the API verifies the
        // latest version, but do not flash the full announcement dialog again.
        active = false;
        forced = false;
        const modal = getElement('announcementModal');
        modal?.classList.remove('show');
        modal?.setAttribute('aria-hidden', 'true');
      } else {
        setOpen(true, { force: true, focus: false });
      }
      return load({ initial: true });
    }

    function refresh() {
      return load({ forceReload: true });
    }

    function open(trigger = null) {
      previousFocus = trigger || documentRef?.activeElement || null;
      if (!initialized) {
        setOpen(true, { force: true });
        void load({ initial: true });
        return;
      }
      renderLatest();
      setOpen(true, { force: latestIsUnread() });
    }

    function close() {
      if (forced) return false;
      return setOpen(false, { force: false });
    }

    function acknowledge() {
      const latest = latestAnnouncement();
      if (!latest) return false;
      if (latestIsUnread()) writeAcknowledgedVersions(announcements.map(item => item?.version));
      renderLatest();
      setOpen(false, { force: false });
      return true;
    }

    function toggleHistory() {
      const panel = getElement('announcementHistoryPanel');
      const button = getElement('announcementHistoryBtn');
      if (!panel || !button || button.hidden) return false;
      const expanded = panel.hidden;
      panel.hidden = !expanded;
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      button.textContent = expanded ? '收起历史公告' : `查看历史公告（${Math.max(0, announcements.length - 1)}）`;
      if (expanded) panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return expanded;
    }

    function bind() {
      documentRef?.querySelectorAll?.('[data-announcement-open]')?.forEach(node => {
        if (node.dataset.announcementBound === '1') return;
        node.dataset.announcementBound = '1';
        node.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          open(node);
        });
      });
      getElement('closeAnnouncementBtn')?.addEventListener('click', close);
      getElement('acknowledgeAnnouncementBtn')?.addEventListener('click', acknowledge);
      getElement('announcementHistoryBtn')?.addEventListener('click', toggleHistory);
      documentRef?.querySelectorAll?.('[data-close-announcement]')?.forEach(node => node.addEventListener('click', close));
      getElement('announcementModal')?.addEventListener('keydown', event => {
        event.stopPropagation();
        if (!active) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!forced) close();
          return;
        }
        if (!forced || event.key !== 'Tab') return;
        const dialog = getElement('announcementModal')?.querySelector?.('.announcement-dialog');
        const focusable = [...(dialog?.querySelectorAll?.('button:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])') || [])]
          .filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && documentRef.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && documentRef.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      documentRef?.addEventListener('keydown', event => {
        if (!active || !forced || getElement('announcementModal')?.contains?.(event.target)) return;
        event.preventDefault();
        getElement('acknowledgeAnnouncementBtn')?.focus?.({ preventScroll: true });
      }, true);
    }

    return Object.freeze({
      acknowledge,
      bind,
      close,
      initialize,
      load,
      open,
      refresh,
      readAcknowledgedVersions,
      toggleHistory,
    });
  }

  const api = Object.freeze({
    DEFAULT_REQUEST_TIMEOUT_MS,
    READ_ANNOUNCEMENTS_KEY,
    announcementMarkdown,
    createAnnouncementCenterController,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.document) {
    const controller = createAnnouncementCenterController();
    root.ChatUIAnnouncementCenter = Object.freeze({ ...api, controller });
    controller.bind();
    void controller.initialize();
    const refresh = () => {
      if (root.document?.visibilityState === 'hidden') return;
      void controller.refresh().catch(() => {});
    };
    root.addEventListener?.('focus', refresh);
    root.addEventListener?.('pageshow', refresh);
    root.document?.addEventListener?.('visibilitychange', refresh);
    const refreshTimer = root.setInterval?.(refresh, 5 * 60 * 1000);
    refreshTimer?.unref?.();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
