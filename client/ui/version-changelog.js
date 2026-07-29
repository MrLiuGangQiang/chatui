(function initVersionChangelog(root) {
  'use strict';

  const INITIAL_RELEASE_COUNT = 12;
  const RELEASE_BATCH_SIZE = 12;

  function comparableReleaseLabel(value = '') {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^chatui[\s·:：-]*/i, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  function releaseSubtitle(release = {}, version = '') {
    const title = String(release.title || '').trim();
    if (!title || comparableReleaseLabel(title) === comparableReleaseLabel(version)) return '';
    return title;
  }

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

      function renderBody(body, release) {
        if (body.dataset.rendered === '1') return;
        body.dataset.rendered = '1';
        const markdown = String(release.body || '').replace(/^#\s+.*(?:\r?\n|$)/, '').trim();
        if (typeof markdownRenderer === 'function') body.innerHTML = markdownRenderer(markdown);
        else body.textContent = markdown;
        body.querySelectorAll?.('table')?.forEach(table => {
          if (table.parentElement?.classList.contains('changelog-table-wrap')) return;
          const wrapper = documentRef.createElement('div');
          wrapper.className = 'changelog-table-wrap';
          table.parentNode?.insertBefore(wrapper, table);
          wrapper.appendChild(table);
        });
      }

      function createEntry(release, index) {
        const version = String(release.version || '').trim() || '未标记版本';
        const subtitle = releaseSubtitle(release, version);
        const entry = documentRef.createElement('details');
        entry.className = `changelog-entry${index === 0 ? ' is-latest' : ''}`;
        entry.open = index === 0;

        const summary = documentRef.createElement('summary');
        summary.className = 'changelog-entry-summary';
        summary.setAttribute('aria-label', `${version}${subtitle ? `，${subtitle}` : ''}`);
        const heading = documentRef.createElement('span');
        heading.className = 'changelog-entry-heading';
        const versionLabel = documentRef.createElement('span');
        versionLabel.className = 'changelog-entry-version';
        versionLabel.textContent = version;
        heading.appendChild(versionLabel);
        if (subtitle) {
          const subtitleLabel = documentRef.createElement('span');
          subtitleLabel.className = 'changelog-entry-title';
          subtitleLabel.textContent = subtitle;
          heading.appendChild(subtitleLabel);
        }
        if (index === 0) {
          const latest = documentRef.createElement('span');
          latest.className = 'changelog-latest-badge';
          latest.textContent = '最新版本';
          heading.appendChild(latest);
        }
        const chevron = documentRef.createElement('span');
        chevron.className = 'changelog-entry-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        summary.append(heading, chevron);

        const panel = documentRef.createElement('div');
        panel.className = 'changelog-entry-panel';
        const body = documentRef.createElement('div');
        body.className = 'changelog-entry-body';
        panel.appendChild(body);
        entry.append(summary, panel);
        const ensureRendered = () => {
          if (entry.open) renderBody(body, release);
        };
        entry.addEventListener('toggle', ensureRendered);
        ensureRendered();
        return entry;
      }

      const list = documentRef.createElement('div');
      list.className = 'changelog-list';
      let renderedCount = 0;
      const appendBatch = count => {
        const end = Math.min(releases.length, renderedCount + count);
        for (let index = renderedCount; index < end; index += 1) {
          list.appendChild(createEntry(releases[index], index));
        }
        renderedCount = end;
      };
      appendBatch(INITIAL_RELEASE_COUNT);
      content.appendChild(list);

      if (renderedCount < releases.length) {
        const more = documentRef.createElement('button');
        more.className = 'changelog-more';
        more.type = 'button';
        const updateMoreLabel = () => {
          const remaining = releases.length - renderedCount;
          more.textContent = `查看更早版本（剩余 ${remaining} 个）`;
        };
        updateMoreLabel();
        more.addEventListener('click', () => {
          appendBatch(RELEASE_BATCH_SIZE);
          if (renderedCount >= releases.length) more.remove();
          else updateMoreLabel();
        });
        content.appendChild(more);
      }
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
