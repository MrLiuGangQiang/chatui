(function initChatUIAppFormatting(root) {
  'use strict';

  function formatElapsed(ms) {
    if (Number.isFinite(ms) && ms < 1000) return ms > 0 && ms < 1 ? '<1ms' : `${Math.max(0, Math.round(ms))}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  function firstTokenTimeText(ms) {
    return Number.isFinite(ms) ? `TTFT ${formatElapsed(ms)}` : '';
  }

  function responseMetricsText({ firstTokenMs = null, durationMs = null, includeFirstToken = true, includeDuration = true } = {}) {
    const parts = [];
    if (includeFirstToken && Number.isFinite(firstTokenMs)) parts.push(`TTFT ${formatElapsed(firstTokenMs)}`);
    if (includeDuration && Number.isFinite(durationMs)) parts.push(`RT ${formatElapsed(durationMs)}`);
    return parts.join(' · ');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"'`]/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
      '`': '&#96;',
    }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;');
  }

  function renderStreamingText(value) {
    return `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`;
  }

  function pendingFeedbackHtml(value) {
    const text = String(value || '正在执行：等待任务开始');
    const stage = /路由|识别|预检/.test(text) ? 3
      : /准备|上传|上一张图片/.test(text) ? 4
        : /处理中|等待模型|连接模型|思考|接收|生成图片|修改图片|已等待/.test(text) ? 5 : 2;
    const steps = ['接收任务', '保存上下文', '路由预检', '准备请求', '执行并等待响应'];
    const map = steps.map((label, index) => {
      const number = index + 1;
      const state = number < stage ? 'done' : number === stage ? 'active' : '';
      return `<span class="pending-map-step ${state}"><b>${number}</b>${label}</span>`;
    }).join('');
    return `<div class="pending-feedback" data-execution-map="true" aria-live="polite"><div class="pending-feedback-head"><span class="pending-orb" aria-hidden="true"></span><span class="pending-text">${escapeHtml(text)}</span><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="pending-map" aria-label="执行地图：当前第 ${stage} 步">${map}</div></div>`;
  }

  function isChatStatusText(value = '') {
    return /正在执行：|正在接收任务|正在准备消息|正在识别任务|正在连接模型|正在启动图片任务|正在处理中 请稍后|正在处理|正在思考|正在恢复聊天任务|恢复任务不存在|已停止恢复|已收到|请稍等|已等待/.test(String(value || ''));
  }

  const api = Object.freeze({
    formatElapsed,
    firstTokenTimeText,
    responseMetricsText,
    escapeHtml,
    escapeAttr,
    renderStreamingText,
    pendingFeedbackHtml,
    isChatStatusText,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppFormatting = api;
  if (root?.window) root.window.ChatUIAppFormatting = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
