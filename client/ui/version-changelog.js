(function initVersionChangelog(root) {
  'use strict';

  function createVersionChangelogController(options = {}) {
    const documentRef = options.document || root?.document;
    const fetchImpl = options.fetchImpl || root?.fetch?.bind(root);
    const markdownRenderer = options.renderMarkdown
      || root?.ChatUIMarkdown?.renderMarkdown
      || root?.ChatUIApp?.markdown?.renderMarkdown;
    const getElement = id => documentRef?.getElementById(id);
    let active = false;
    let previousFocus = null;

    function setOpen(open) {
      const modal = getElement('changelogModal');
      if (!modal) return;
      active = open;
      modal.classList.toggle('show', open);
      modal.setAttribute('aria-hidden', open ? 'false' : 'true');
      documentRef?.body?.classList.toggle('modal-open', open);
      if (open) getElement('closeChangelogBtn')?.focus?.();
      else previousFocus?.focus?.();
    }

    function render(releases) {
      const content = getElement('changelogContent');
      if (!content) return;
      content.textContent = '';
      if (!Array.isArray(releases) || !releases.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'changelog-status';
        empty.textContent = '暂无更新日志';
        content.appendChild(empty);
        return;
      }
      releases.forEach(release => {
        const article = documentRef.createElement('article');
        article.className = 'changelog-entry';
        const heading = documentRef.createElement('h3');
        heading.textContent = `${release.version || ''} ${release.title || ''}`.trim();
        const body = documentRef.createElement('div');
        body.className = 'changelog-entry-body';
        const markdown = String(release.body || '').replace(/^#\s+.*(?:\r?\n|$)/, '').trim();
        if (typeof markdownRenderer === 'function') {
          body.innerHTML = markdownRenderer(markdown);
        } else {
          body.textContent = markdown;
        }
        article.append(heading, body);
        content.appendChild(article);
      });
    }

    async function load() {
      const content = getElement('changelogContent');
      if (!fetchImpl) return;
      if (content) content.innerHTML = '<p class="changelog-status">正在加载更新日志…</p>';
      try {
        const response = await fetchImpl('/api/changelog', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        render(payload?.releases);
      } catch {
        if (content) content.innerHTML = '<p class="changelog-status">更新日志加载失败，请稍后重试</p>';
      }
    }

    function open(trigger) {
      previousFocus = trigger || documentRef?.activeElement || null;
      setOpen(true);
      void load();
    }

    function close() { setOpen(false); }

    function bind() {
      documentRef?.querySelectorAll?.('[data-version-changelog]')?.forEach(node => {
        if (node.dataset.changelogBound === '1') return;
        node.dataset.changelogBound = '1';
        node.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          open(node);
        });
        node.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          open(node);
        });
      });
      getElement('closeChangelogBtn')?.addEventListener('click', close);
      documentRef?.querySelectorAll?.('[data-close-changelog]')?.forEach(node => node.addEventListener('click', close));
      documentRef?.addEventListener('keydown', event => {
        if (event.key === 'Escape' && active) close();
      });
    }

    return Object.freeze({ bind, open, close, load });
  }

  const api = Object.freeze({ createVersionChangelogController });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.document) {
    const controller = createVersionChangelogController();
    controller.bind();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
