(function initChatUIAppFormatting(root) {
  'use strict';

  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});

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

  function pendingDotsHtml() {
    return '<span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
  }

  function pendingFeedbackRowHtml(value) {
    return `<span class="pending-feedback-row"><span class="pending-orb" aria-hidden="true"></span><span class="pending-text">${escapeHtml(value)}</span>${pendingDotsHtml()}</span>`;
  }

  function pendingFeedbackHtml(value) {
    const text = String(value || executionStatus.operationStatusText?.('', 'prepare') || '正在准备执行任务');
    const lines = text.split(/\r?\n/);
    const multiline = lines.length > 1;
    const rows = lines.map(line => pendingFeedbackRowHtml(line));
    return `<div class="pending-feedback${multiline ? ' pending-feedback-multiline' : ''}" data-live-status="true" role="status" aria-live="polite" aria-atomic="true">${rows.join('')}</div>`;
  }

  function isChatStatusText(value = '') {
    if (executionStatus.isExecutionStatusText?.(value)) return true;
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
    pendingFeedbackRowHtml,
    isChatStatusText,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppFormatting = api;
  if (root?.window) root.window.ChatUIAppFormatting = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
