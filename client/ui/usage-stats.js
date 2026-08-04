(() => {
  const textHash = (typeof window !== 'undefined' && window[Symbol.for('chatui.module-registry.v1')]?.get('textHash'))
    || (typeof require === 'function' ? require('../core/text-hash') : {});
  const shortHash = textHash.fnv1aBase36 || (value => String(value || ''));
  const format = (typeof window !== 'undefined' && window.ChatUIUsageStatsFormat) || (typeof require === 'function' ? require('./usage-stats-format') : {});
  const auth = (typeof window !== 'undefined' && window.ChatUIUsageStatsAuth) || (typeof require === 'function' ? require('./usage-stats-auth') : {});
  const view = (typeof window !== 'undefined' && window.ChatUIUsageStatsViewHelpers) || (typeof require === 'function' ? require('../features/usage-stats/view-helpers') : {});
  const viewHelpers = typeof view.createUsageStatsViewHelpers === 'function' ? view.createUsageStatsViewHelpers(format) : view;
  const RANKING_TABS = viewHelpers.RANKING_TABS || viewHelpers.DEFAULT_RANKING_TABS || [];
  const DEPARTMENT_TABS = viewHelpers.DEPARTMENT_TABS || viewHelpers.DEFAULT_DEPARTMENT_TABS || [];

  const $ = id => document.getElementById(id);
  const {
    escapeHtml,
    formatTokens,
    fullNumber,
    cachePercent,
    reasoningPercent,
    formatMetricValue,
    fullMetricValue,
  } = format;
  const {
    currentApiKey: readCurrentApiKey,
    shouldLoadRanking,
    getDepartmentPassword,
    setDepartmentPassword,
    clearDepartmentPassword,
  } = auth;

  function currentApiKey() {
    return readCurrentApiKey({ getElement: $ });
  }

  function currentModel() {
    return String($('chatModel')?.value || '').trim();
  }

  function currentRouteModel() {
    return String($('routeModel')?.value || '').trim();
  }

  const FEEDBACK_MODEL_CONTEXT_HEADING = '【模型信息（自动填写）】';
  const FEEDBACK_USER_TEMPLATE = '【问题描述】\n\n【复现描述】\n\n【期望结果】';
  const FEEDBACK_USER_MAX_LENGTH = 3700;
  const USAGE_STATS_ICON_SVG = `<svg class="neon-entry-icon usage-stats-entry-icon" viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id="usageStatsIconGradient" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#60a5fa"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
    <path class="usage-stats-orbit" d="M4.1 13.4a8.2 8.2 0 0 1 13.8-6M19.9 10.6a8.2 8.2 0 0 1-13.8 6" stroke="url(#usageStatsIconGradient)" opacity=".48"/>
    <path class="usage-stats-grid" d="M5 19h14M6.7 16.5V13h3v3.5M10.6 16.5V9.8h3v6.7M14.5 16.5V6.6h3v9.9" stroke="url(#usageStatsIconGradient)"/>
    <path class="usage-stats-trend" d="m6.7 11.1 4-3 2.8 1.5 4.1-4" stroke="url(#usageStatsIconGradient)"/>
    <circle class="usage-stats-pulse" cx="17.6" cy="5.6" r="1.25" fill="#67e8f9" stroke="none"/>
  </svg>`;
  const USAGE_FEEDBACK_ICON_SVG = `<svg class="neon-entry-icon usage-feedback-entry-icon" viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id="usageFeedbackIconGradient" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#22d3ee"/><stop offset=".5" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>
    <path class="usage-feedback-back" d="M5.2 6.1h11.6a3.2 3.2 0 0 1 3.2 3.2v5.2a3.2 3.2 0 0 1-3.2 3.2h-5.7l-4.4 2.8v-2.8H5.2A3.2 3.2 0 0 1 2 14.5V9.3a3.2 3.2 0 0 1 3.2-3.2Z" fill="url(#usageFeedbackIconGradient)" fill-opacity=".09" stroke="url(#usageFeedbackIconGradient)"/>
    <path class="usage-feedback-wave" d="M6 12h2l1.2-2.2 2.1 4.4 1.6-3 1 1.8H18" stroke="url(#usageFeedbackIconGradient)"/>
    <path class="usage-feedback-spark" d="m18.7 2 .5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="#f0abfc" stroke="none"/>
  </svg>`;

  function feedbackUserContent(content = '') {
    const normalized = String(content || '').replace(/\r\n?/g, '\n').trim();
    const markerIndex = normalized.lastIndexOf(FEEDBACK_MODEL_CONTEXT_HEADING);
    return (markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized).trim();
  }

  function feedbackModelContext({ routeModel = '', chatModel = '' } = {}) {
    const chat = String(chatModel || '').trim() || '未配置';
    const route = String(routeModel || '').trim() || `${chat}（跟随聊天模型）`;
    return `${FEEDBACK_MODEL_CONTEXT_HEADING}\n意图模型：${route}\n聊天模型：${chat}`;
  }

  function feedbackDraft(content = '', models = {}) {
    const userContent = feedbackUserContent(content) || FEEDBACK_USER_TEMPLATE;
    return `${userContent}\n\n${feedbackModelContext(models)}`;
  }

  function feedbackContentFromFields({ problem = '', reproduction = '', expected = '' } = {}) {
    return `【问题描述】\n${String(problem || '').trim()}\n\n【复现描述】\n${String(reproduction || '').trim()}\n\n【期望结果】\n${String(expected || '').trim()}`.trim();
  }

  function ensureDom() {
    if ($('usageStatsButton')) return;
    const button = document.createElement('button');
    button.id = 'usageStatsButton';
    button.className = 'usage-stats-button';
    button.type = 'button';
    button.title = '使用统计';
    button.setAttribute('aria-label', '使用统计');
    button.innerHTML = USAGE_STATS_ICON_SVG;

    const feedbackButton = document.createElement('button');
    feedbackButton.id = 'usageFeedbackOpen';
    feedbackButton.className = 'usage-feedback-open';
    feedbackButton.type = 'button';
    feedbackButton.title = '问题反馈';
    feedbackButton.setAttribute('aria-label', '问题反馈');
    feedbackButton.innerHTML = USAGE_FEEDBACK_ICON_SVG;

    const panel = document.createElement('section');
    panel.id = 'usageStatsPanel';
    panel.className = 'usage-stats-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <div class="usage-stats-card" role="dialog" aria-modal="false" aria-labelledby="usageStatsTitle">
        <div class="usage-stats-head">
          <div>
            <strong id="usageStatsTitle">使用统计</strong>
            <span id="usageStatsSubtitle">个人统计</span>
          </div>
          <div class="usage-stats-actions">
            <span id="usageStatsStatus" class="usage-stats-status" aria-live="polite"></span>
            <button id="usageStatsModeToggle" class="usage-mode-toggle" type="button" title="切换部门统计" aria-label="切换部门统计">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 17h16"/><path d="M7 4 4 7l3 3"/><path d="M17 14l3 3-3 3"/></svg>
            </button>
            <button id="usageStatsExport" class="usage-export-button" type="button" title="导出部门统计 Excel" aria-label="导出部门统计 Excel">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/><path d="M6 17v4"/><path d="M18 17v4"/></svg>
            </button>
            <button id="usageStatsRefresh" type="button" title="刷新" aria-label="刷新统计">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M4 12A8 8 0 0 1 17.66 6.34"/><path d="M17 2v5h5"/><path d="M7 22v-5H2"/></svg>
            </button>
            <button id="usageStatsClose" type="button" aria-label="关闭">×</button>
          </div>
        </div>
        <div id="usagePersonal" class="usage-personal"></div>
        <div class="usage-stats-body">
          <div id="usageTabs" class="usage-tabs" role="tablist"></div>
          <div id="usageRanking" class="usage-ranking"></div>
        </div>
      </div>`;
    const feedbackPanel = document.createElement('section');
    feedbackPanel.id = 'usageFeedbackPanel';
    feedbackPanel.className = 'usage-feedback-panel';
    feedbackPanel.setAttribute('aria-hidden', 'true');
    feedbackPanel.innerHTML = `
      <div class="usage-feedback-card" role="dialog" aria-modal="true" aria-labelledby="usageFeedbackTitle">
        <div class="usage-feedback-head">
          <div class="usage-feedback-heading"><span>帮助我们持续改进</span><strong id="usageFeedbackTitle">提交问题反馈</strong></div>
          <button id="usageFeedbackClose" type="button" aria-label="关闭反馈">×</button>
        </div>
        <div class="usage-feedback-body">
          <p class="usage-feedback-intro">按下面三步补充信息，提交前会由当前聊天模型检查内容是否足够清楚。</p>
          <div class="usage-feedback-fields">
            <label class="usage-feedback-field" for="usageFeedbackProblem"><span class="usage-feedback-step">1</span><span><strong>问题描述</strong><em>发生了什么？</em></span><textarea id="usageFeedbackProblem" maxlength="1400" placeholder="例如：移动端点击会话后，页面仍停留在原会话。"></textarea></label>
            <label class="usage-feedback-field" for="usageFeedbackReproduction"><span class="usage-feedback-step">2</span><span><strong>复现描述</strong><em>怎样可以再次出现？</em></span><textarea id="usageFeedbackReproduction" maxlength="1400" placeholder="例如：打开会话侧栏，点击任意其他会话。"></textarea></label>
            <label class="usage-feedback-field" for="usageFeedbackExpected"><span class="usage-feedback-step">3</span><span><strong>期望结果</strong><em>正确行为应是什么？</em></span><textarea id="usageFeedbackExpected" maxlength="900" placeholder="例如：应立即切换并显示所选会话的消息。"></textarea></label>
          </div>
          <div class="usage-feedback-models" aria-label="本次反馈使用的模型信息"><div class="usage-feedback-models-title">模型信息 <span>自动记录</span></div><div id="usageFeedbackModels" class="usage-feedback-model-values"></div></div>
          <div class="usage-feedback-notice"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v5"/><path d="M12 7h.01"/></svg><div><span>只需填写上方内容；模型信息会由系统自动附加。</span></div><span id="usageFeedbackCount">0 / 3700</span></div>
          <div id="usageFeedbackStatus" class="usage-feedback-status" aria-live="polite"></div>
        </div>
        <div class="usage-feedback-foot"><button id="usageFeedbackCancel" type="button">取消</button><button id="usageFeedbackSubmit" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>提交反馈</button></div>
      </div>`;
    document.body.append(button, feedbackButton, panel, feedbackPanel);
  }

  const tokenColumns = viewHelpers.tokenColumns;

  function renderPersonal(personal, hasApiKey) {
    const el = $('usagePersonal');
    if (!el) return;
    if (activeMode === 'department') {
      el.innerHTML = '';
      return;
    }
    if (!hasApiKey) {
      el.innerHTML = '<div class="usage-empty">未配置 API Key，无法展示个人统计。</div>';
      return;
    }
    if (!personal) {
      el.innerHTML = '<div class="usage-empty">暂无个人统计数据。</div>';
      return;
    }
    const row = personal;
    el.innerHTML = `
      <div class="usage-personal-total" title="${fullNumber(row.total_tokens)}">
        <div>
          <span>${rangeLabel(activePersonalRange)}总用量</span>
          <strong>${formatTokens(row.total_tokens)}</strong>
        </div>
        <div class="usage-personal-name">${escapeHtml(row.username || '当前 API Key')}</div>
      </div>
      <div class="usage-personal-side">
        <div class="usage-personal-ranges">
          ${RANKING_TABS.map(([key]) => `<button type="button" data-personal-range="${key}" class="${key === activePersonalRange ? 'active' : ''}">${rangeLabel(key)}</button>`).join('')}
        </div>
        <div class="usage-metrics usage-personal-fields">
          ${tokenColumns(row).slice(1).map(([label, value, type], index) => `<div class="usage-personal-metric usage-personal-metric-${index}" title="${fullMetricValue(value, type)}"><span>${label}</span><strong>${formatMetricValue(value, type)}</strong></div>`).join('')}
        </div>
      </div>
    `;
  }

  const rangeLabel = viewHelpers.rangeLabel;

  function tabLabel(range) {
    return viewHelpers.tabLabel(range, activeMode);
  }

  const renderTokenBadges = viewHelpers.renderTokenBadges;

  const renderRankIcon = viewHelpers.renderRankIcon;

  const renderRankIndex = viewHelpers.renderRankIndex;

  function renderTabs() {
    const tabs = activeMode === 'department' ? DEPARTMENT_TABS : RANKING_TABS;
    const selected = activeMode === 'department' ? activeDepartmentRange : activeRange;
    const el = $('usageTabs');
    if (!el) return;
    el.classList.toggle('usage-tabs-department', activeMode === 'department');
    el.innerHTML = tabs.map(([key, label]) => `<button type="button" data-usage-tab="${key}" class="${key === selected ? 'active' : ''}">${label}</button>`).join('');
  }

  function renderRanking(rows = [], range = 'today') {
    const el = $('usageRanking');
    if (!el) return;
    const title = tabLabel(range);
    if (!rows.length) {
      el.innerHTML = `<div class="usage-ranking-title">${title}</div><div class="usage-empty">暂无排行数据。</div>`;
      return;
    }
    el.innerHTML = `
      <div class="usage-ranking-title">${title}</div>
      <div class="usage-ranking-list">
        ${rows.map((row, index) => {
          const name = activeMode === 'department' ? (row.department_name || '-') : (row.username || '-');
          const deptAttrs = activeMode === 'department' ? ` role="button" tabindex="0" data-department-id="${escapeHtml(row.department_id)}" data-department-name="${escapeHtml(name)}"` : '';
          return `
          <div class="usage-ranking-row${activeMode === 'department' ? ' usage-department-row' : ''}"${deptAttrs}>
            ${renderRankIndex(index)}
            <span class="usage-ranking-user" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="usage-token-grid">${renderTokenBadges(row, { raw: activeMode === 'department' })}</div>
          </div>`;
        }).join('')}
      </div>`;
  }

  function renderDepartmentUsers(departmentName, rows = []) {
    const el = $('usageRanking');
    if (!el) return;
    el.innerHTML = `
      <div class="usage-ranking-title usage-drill-title"><button type="button" id="usageBackDepartments">← 部门排行</button><span>${escapeHtml(departmentName)} · ${tabLabel(activeDepartmentRange)}人员统计</span></div>
      ${rows.length ? `<div class="usage-ranking-list">${rows.map((row, index) => `
        <div class="usage-ranking-row">
          ${renderRankIndex(index)}
          <span class="usage-ranking-user" title="${escapeHtml(row.username || '-')}">${escapeHtml(row.username || '-')}</span>
          <div class="usage-token-grid">${renderTokenBadges(row, { raw: true })}</div>
        </div>`).join('')}</div>` : '<div class="usage-empty">暂无人员统计数据。</div>'}`;
  }

  const CACHE_TTL_MS = 30 * 1000;
  let cache = { rankings: {}, personal: {}, departmentRankings: {}, departmentUsers: {}, fetchedAt: {} };
  let activeRange = 'today';
  let activePersonalRange = 'today';
  let activeDepartmentRange = 'today';
  let activeMode = 'personal';
  let activeDepartmentDetail = null;

  function clearDepartmentCache() {
    cache.departmentRankings = {};
    cache.departmentUsers = {};
    Object.keys(cache.fetchedAt).forEach(key => key.startsWith('department:') && delete cache.fetchedAt[key]);
  }

  function cacheFresh(key) {
    return Date.now() - Number(cache.fetchedAt[key] || 0) < CACHE_TTL_MS;
  }

  function markFetched(key) {
    cache.fetchedAt[key] = Date.now();
  }

  function personalCacheKey(range, apiKey = currentApiKey()) {
    return `personal:${shortHash(apiKey)}:${range}`;
  }

  function usageService() {
    return window.ChatUIServices?.usageStats;
  }

  function showUsageLimit(message) {
    const status = $('usageStatsStatus');
    if (!status) return;
    status.innerHTML = `<span class="usage-stats-warning-icon" aria-hidden="true">⚠️</span><span>${escapeHtml(message || '请不要频繁刷新，请一分钟后重试')}</span>`;
    status.classList.add('is-warning');
  }

  function clearUsageLimit() {
    const status = $('usageStatsStatus');
    if (!status) return;
    status.textContent = '';
    status.classList.remove('is-warning');
  }

  function setFeedbackStatus(message = '', isError = false) {
    const status = $('usageFeedbackStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(message && isError));
    status.classList.toggle('is-success', Boolean(message && !isError));
  }

  function feedbackFields() {
    return {
      problem: String($('usageFeedbackProblem')?.value || ''),
      reproduction: String($('usageFeedbackReproduction')?.value || ''),
      expected: String($('usageFeedbackExpected')?.value || ''),
    };
  }

  function renderFeedbackModels() {
    const el = $('usageFeedbackModels');
    if (!el) return;
    const chat = currentModel() || '未配置';
    const route = currentRouteModel() || `${chat}（跟随聊天模型）`;
    el.innerHTML = `<div><span>意图模型</span><code>${escapeHtml(route)}</code></div><div><span>聊天模型</span><code>${escapeHtml(chat)}</code></div>`;
  }

  function clearFeedbackFieldErrors() {
    ['usageFeedbackProblem', 'usageFeedbackReproduction', 'usageFeedbackExpected'].forEach(id => $(id)?.classList.remove('is-invalid'));
  }

  function validateFeedbackFields(fields = feedbackFields()) {
    const required = [
      ['usageFeedbackProblem', fields.problem, '问题描述'],
      ['usageFeedbackReproduction', fields.reproduction, '复现描述'],
      ['usageFeedbackExpected', fields.expected, '期望结果'],
    ];
    clearFeedbackFieldErrors();
    const missing = required.filter(([, value]) => !String(value || '').trim());
    missing.forEach(([id]) => $(id)?.classList.add('is-invalid'));
    return missing.length ? `请补充：${missing.map(([, , label]) => label).join('、')}` : '';
  }

  function openFeedbackPanel() {
    closePanel();
    const configured = Boolean(currentApiKey() && currentModel());
    setFeedbackStatus(configured ? '' : '请先在模型配置中填写 API Key 并选择聊天模型', !configured);
    renderFeedbackModels();
    clearFeedbackFieldErrors();
    updateFeedbackCount();
    $('usageFeedbackPanel')?.classList.add('show');
    $('usageFeedbackPanel')?.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      $('usageFeedbackProblem')?.focus();
    }, 0);
  }

  function closeFeedbackPanel() {
    $('usageFeedbackPanel')?.classList.remove('show');
    $('usageFeedbackPanel')?.setAttribute('aria-hidden', 'true');
    setFeedbackStatus();
  }

  function updateFeedbackCount() {
    const count = $('usageFeedbackCount');
    if (count) count.textContent = `${Object.values(feedbackFields()).join('').length} / ${FEEDBACK_USER_MAX_LENGTH}`;
  }

  async function submitFeedback() {
    if (!currentApiKey() || !currentModel()) return setFeedbackStatus('请先在模型配置中填写 API Key 并选择聊天模型', true);
    const fields = feedbackFields();
    const validationMessage = validateFeedbackFields(fields);
    if (validationMessage) return setFeedbackStatus(validationMessage, true);
    const content = feedbackContentFromFields(fields);
    const submit = $('usageFeedbackSubmit');
    submit && (submit.disabled = true);
    setFeedbackStatus('正在调用模型审核反馈内容…');
    try {
      await usageService()?.submitFeedback(content, currentApiKey(), currentModel(), currentRouteModel());
      ['usageFeedbackProblem', 'usageFeedbackReproduction', 'usageFeedbackExpected'].forEach(id => { const field = $(id); if (field) field.value = ''; });
      updateFeedbackCount();
      setFeedbackStatus('反馈已发送，感谢你的反馈。');
      setTimeout(closeFeedbackPanel, 900);
    } catch (err) {
      const reason = String(err?.reviewReason || err?.message || '').trim();
      setFeedbackStatus(reason || '反馈发送失败，请稍后重试', true);
    } finally {
      submit && (submit.disabled = false);
    }
  }

  function modeToggleIcon() {
    return viewHelpers.modeToggleIcon(activeMode);
  }

  async function promptAndVerifyDepartmentPassword() {
    const password = String(window.prompt('请输入部门统计访问密码') || '').trim();
    if (!password) return false;
    const payload = await usageService().verifyDepartmentPassword(password, currentApiKey(), currentModel());
    if (!payload?.available) throw new Error(payload?.reason || '部门统计未启用');
    if (!payload?.authorized) throw new Error('密码错误，无权限访问');
    setDepartmentPassword(password);
    clearDepartmentCache();
    return true;
  }

  async function ensureDepartmentAccess() {
    const savedPassword = getDepartmentPassword();
    if (savedPassword) {
      try {
        const payload = await usageService().verifyDepartmentPassword(savedPassword, currentApiKey(), currentModel());
        if (!payload?.available) throw new Error(payload?.reason || '部门统计未启用');
        if (payload?.authorized) return true;
      } catch (err) {
        if (!String(err.message || '').includes('密码错误')) throw err;
      }
      clearDepartmentPassword();
      clearDepartmentCache();
      showUsageLimit('已保存的部门统计密码无效，请重新输入');
    }
    return promptAndVerifyDepartmentPassword();
  }

  async function loadRanking(range, options = {}) {
    if (!shouldLoadRanking(currentApiKey())) {
      cache.rankings[range] = [];
      renderRanking([], range);
      return;
    }
    const cacheKey = `ranking:${range}`;
    if (!options.force && cacheFresh(cacheKey) && cache.rankings[range]) {
      renderRanking(cache.rankings[range], range);
      return;
    }
    const payload = await usageService().requestRanking(currentApiKey(), currentModel(), range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderRanking(cache.rankings[range] || [], range);
      return;
    }
    if (!payload.available) {
      cache.rankings[range] = [];
      renderRanking([], range);
      return;
    }
    cache.rankings[range] = payload.ranking || [];
    markFetched(cacheKey);
    renderRanking(cache.rankings[range], range);
  }

  async function loadPersonal(range, options = {}) {
    const apiKey = currentApiKey();
    if (!apiKey) {
      renderPersonal(null, false);
      return;
    }
    const cacheKey = personalCacheKey(range, apiKey);
    if (!options.force && cacheFresh(cacheKey) && Object.prototype.hasOwnProperty.call(cache.personal, cacheKey)) {
      renderPersonal(cache.personal[cacheKey] || null, true);
      return;
    }
    const payload = await usageService().requestPersonal(apiKey, currentModel(), range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderPersonal(cache.personal[cacheKey] || null, true);
      return;
    }
    cache.personal[cacheKey] = payload?.personal || null;
    markFetched(cacheKey);
    renderPersonal(cache.personal[cacheKey], true);
  }

  async function loadOverview(options = {}) {
    const apiKey = currentApiKey();
    if (!apiKey) {
      cache.rankings[activeRange] = [];
      renderRanking([], activeRange);
      renderPersonal(null, false);
      return;
    }
    const rankingKey = `ranking:${activeRange}`;
    const personalKey = personalCacheKey(activePersonalRange, apiKey);
    if (!options.force && cacheFresh(rankingKey) && cacheFresh(personalKey) && cache.rankings[activeRange] && Object.prototype.hasOwnProperty.call(cache.personal, personalKey)) {
      renderRanking(cache.rankings[activeRange], activeRange);
      renderPersonal(cache.personal[personalKey] || null, true);
      return;
    }
    const service = usageService();
    if (!service?.requestOverview) {
      await Promise.all([loadRanking(activeRange, options), loadPersonal(activePersonalRange, options)]);
      return;
    }
    const payload = await service.requestOverview(apiKey, currentModel(), activeRange, activePersonalRange);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderRanking(cache.rankings[activeRange] || [], activeRange);
      renderPersonal(cache.personal[personalKey] || null, true);
      return;
    }
    if (!payload.available) {
      cache.rankings[activeRange] = [];
      cache.personal[personalKey] = null;
      renderRanking([], activeRange);
      renderPersonal(null, true);
      return;
    }
    cache.rankings[activeRange] = payload.ranking || [];
    cache.personal[personalKey] = payload.personal || null;
    markFetched(rankingKey);
    markFetched(personalKey);
    renderRanking(cache.rankings[activeRange], activeRange);
    renderPersonal(cache.personal[personalKey], true);
  }

  async function loadDepartmentRanking(range, options = {}) {
    const password = getDepartmentPassword();
    const cacheKey = `department:ranking:${range}`;
    if (!options.force && cacheFresh(cacheKey) && cache.departmentRankings[range]) {
      renderRanking(cache.departmentRankings[range], range);
      return;
    }
    const service = usageService();
    const payload = service?.requestDepartmentSummary
      ? await service.requestDepartmentSummary(password, currentApiKey(), currentModel(), range)
      : await service.requestDepartmentRanking(password, currentApiKey(), currentModel(), range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderRanking(cache.departmentRankings[range] || [], range);
      return;
    }
    if (!payload.available) {
      cache.departmentRankings[range] = [];
      renderRanking([], range);
      showUsageLimit(payload.reason || '部门统计不可用');
      return;
    }
    cache.departmentRankings[range] = payload.ranking || [];
    markFetched(cacheKey);
    renderRanking(cache.departmentRankings[range], range);
  }

  async function loadDepartmentUsers(departmentId, departmentName, options = {}) {
    const cacheKey = `${activeDepartmentRange}:${departmentId}`;
    if (!options.force && cache.departmentUsers[cacheKey]) {
      renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey]);
      return;
    }
    const payload = await usageService().requestDepartmentUsers(getDepartmentPassword(), currentApiKey(), currentModel(), departmentId, activeDepartmentRange);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey] || []);
      return;
    }
    cache.departmentUsers[cacheKey] = payload.users || [];
    renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey]);
  }

  async function refreshUsageStats() {
    const refresh = $('usageStatsRefresh');
    clearUsageLimit();
    refresh?.classList.add('is-spinning');
    refresh && (refresh.disabled = true);
    try {
      if (activeMode === 'department') {
        if (activeDepartmentDetail) {
          await loadDepartmentUsers(activeDepartmentDetail.id, activeDepartmentDetail.name, { force: true });
        } else {
          await loadDepartmentRanking(activeDepartmentRange, { force: true });
        }
      } else {
        await loadOverview({ force: true });
      }
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
      showUsageLimit(err.message || '加载失败');
    } finally {
      refresh?.classList.remove('is-spinning');
      refresh && (refresh.disabled = false);
    }
  }

  function updateModeUi() {
    $('usageStatsTitle') && ($('usageStatsTitle').textContent = activeMode === 'department' ? '部门统计' : '使用统计');
    $('usageStatsSubtitle') && ($('usageStatsSubtitle').textContent = activeMode === 'department' ? '部门统计' : '个人统计');
    if ($('usageStatsModeToggle')) {
      $('usageStatsModeToggle').innerHTML = modeToggleIcon();
      $('usageStatsModeToggle').title = activeMode === 'department' ? '切换个人统计' : '切换部门统计';
      $('usageStatsModeToggle').setAttribute('aria-label', activeMode === 'department' ? '切换个人统计' : '切换部门统计');
    }
    $('usageStatsExport')?.classList.toggle('show', activeMode === 'department');
    $('usagePersonal')?.classList.toggle('usage-department-summary', activeMode === 'department');
    $('usageStatsPanel')?.classList.toggle('usage-mode-department', activeMode === 'department');
    renderTabs();
  }

  async function switchMode() {
    clearUsageLimit();
    if (activeMode === 'personal') {
      try {
        const ok = await ensureDepartmentAccess();
        if (!ok) return;
        activeMode = 'department';
        activeDepartmentDetail = null;
        updateModeUi();
        renderPersonal(null, true);
        await loadDepartmentRanking(activeDepartmentRange);
      } catch (err) {
        if (String(err.message || '').includes('密码错误')) {
          clearDepartmentPassword();
          clearDepartmentCache();
        }
        showUsageLimit(err.message || '密码错误，无权限访问');
      }
      return;
    }
    activeMode = 'personal';
    activeDepartmentDetail = null;
    updateModeUi();
    await refreshUsageStats();
  }

  async function handlePersonalRangeClick(button) {
    activePersonalRange = button.dataset.personalRange || 'today';
    document.querySelectorAll('[data-personal-range]').forEach(item => item.classList.toggle('active', item === button));
    try {
      clearUsageLimit();
      await loadPersonal(activePersonalRange);
    } catch (err) {
      showUsageLimit(err.message || '加载失败');
    }
  }

  async function handleUsageTabClick(button) {
    if (activeMode === 'department') activeDepartmentRange = button.dataset.usageTab || 'today';
    else activeRange = button.dataset.usageTab || 'today';
    document.querySelectorAll('[data-usage-tab]').forEach(item => item.classList.toggle('active', item === button));
    try {
      clearUsageLimit();
      if (activeMode === 'department') await loadDepartmentRanking(activeDepartmentRange);
      else await loadRanking(activeRange);
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
      showUsageLimit(err.message || '加载失败');
    }
  }

  async function openDepartmentRow(row) {
    const departmentId = row.dataset.departmentId;
    const departmentName = row.dataset.departmentName || '部门';
    activeDepartmentDetail = { id: departmentId, name: departmentName };
    try {
      clearUsageLimit();
      await loadDepartmentUsers(departmentId, departmentName, { force: true });
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
      showUsageLimit(err.message || '查询部门用户统计失败');
    }
  }

  function handleDelegatedPanelClick(event) {
    const target = event.target;
    if (target?.id === 'usageStatsPanel') return closePanel();
    const backButton = target?.closest?.('#usageBackDepartments');
    if (backButton) {
      activeDepartmentDetail = null;
      return renderRanking(cache.departmentRankings[activeDepartmentRange] || [], activeDepartmentRange);
    }
    const personalRangeButton = target?.closest?.('[data-personal-range]');
    if (personalRangeButton) return handlePersonalRangeClick(personalRangeButton);
    const tabButton = target?.closest?.('[data-usage-tab]');
    if (tabButton) return handleUsageTabClick(tabButton);
    const departmentRow = target?.closest?.('[data-department-id]');
    if (departmentRow) return openDepartmentRow(departmentRow);
  }

  function handleDelegatedPanelKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const departmentRow = event.target?.closest?.('[data-department-id]');
    if (!departmentRow) return;
    event.preventDefault();
    openDepartmentRow(departmentRow);
  }

  async function exportDepartmentUsage() {
    try {
      clearUsageLimit();
      const payload = await usageService().exportDepartmentUsage(getDepartmentPassword(), currentApiKey(), currentModel(), activeDepartmentRange);
      const url = URL.createObjectURL(payload.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = payload.filename || `department-usage-${activeDepartmentRange}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
      showUsageLimit(err.message || '导出部门统计失败');
    }
  }

  function openPanel() {
    $('usageStatsPanel')?.classList.add('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'false');
    updateModeUi();
    refreshUsageStats();
  }

  function closePanel() {
    $('usageStatsPanel')?.classList.remove('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'true');
  }

  function bind() {
    ensureDom();
    updateModeUi();
    $('usageStatsButton')?.addEventListener('click', openPanel);
    $('usageStatsClose')?.addEventListener('click', closePanel);
    $('usageStatsRefresh')?.addEventListener('click', refreshUsageStats);
    $('usageStatsModeToggle')?.addEventListener('click', switchMode);
    $('usageStatsExport')?.addEventListener('click', exportDepartmentUsage);
    $('usageFeedbackOpen')?.addEventListener('click', openFeedbackPanel);
    $('usageFeedbackClose')?.addEventListener('click', closeFeedbackPanel);
    $('usageFeedbackCancel')?.addEventListener('click', closeFeedbackPanel);
    $('usageFeedbackSubmit')?.addEventListener('click', submitFeedback);
    ['usageFeedbackProblem', 'usageFeedbackReproduction', 'usageFeedbackExpected'].forEach(id => $(id)?.addEventListener('input', () => {
      $(id)?.classList.remove('is-invalid');
      updateFeedbackCount();
    }));
    $('usageFeedbackPanel')?.addEventListener('click', event => { if (event.target?.id === 'usageFeedbackPanel') closeFeedbackPanel(); });
    $('usageStatsPanel')?.addEventListener('click', handleDelegatedPanelClick);
    $('usageStatsPanel')?.addEventListener('keydown', handleDelegatedPanelKeydown);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {
    currentApiKey,
    renderPersonal,
    renderRanking,
    renderDepartmentUsers,
    feedbackUserContent,
    feedbackModelContext,
    feedbackDraft,
    feedbackContentFromFields,
  };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
