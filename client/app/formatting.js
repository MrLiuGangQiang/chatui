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
    const text = executionStatus.humanizeStatusText?.(value || executionStatus.operationStatusText?.('', 'prepare') || '正在准备执行任务') || String(value || executionStatus.operationStatusText?.('', 'prepare') || '正在准备执行任务');
    const lines = text.split(/\r?\n/);
    const multiline = lines.length > 1;
    const rows = lines.map(line => pendingFeedbackRowHtml(line));
    return `<div class="pending-feedback${multiline ? ' pending-feedback-multiline' : ''}" data-live-status="true" role="status" aria-live="polite" aria-atomic="true">${rows.join('')}</div>`;
  }

  function intentReasoningMarker(status = '') {
    if (status === 'failed') return '✕';
    if (status === 'completed') return '✓';
    return '·';
  }

  function intentReasoningHtml(trace = {}, { collapsed = false, currentStatus = '' } = {}) {
    const steps = Array.isArray(trace?.steps) ? trace.steps : [];
    const humanize = executionStatus.humanizeStatusText || (value => String(value || ''));
    const terminal = ['ready', 'clarify', 'failed', 'hidden'].includes(String(trace?.status || ''));
    const title = String(currentStatus || '').trim() || (terminal ? '已理解你的请求' : '正在理解你的请求');
    const rows = steps.map(step => {
      const status = String(step?.status || 'completed');
      const summary = humanize(step?.summary || step?.stage || '正在处理');
      const decision = step?.decision ? `：${humanize(step.decision)}` : '';
      const evidence = Array.isArray(step?.evidence) && step.evidence.length ? ` · ${step.evidence.map(humanize).join(' · ')}` : '';
      return `<div class="intent-reasoning-step${step === steps.at(-1) && !terminal ? ' is-current' : ''}" role="listitem"><span class="intent-reasoning-marker" aria-hidden="true">${intentReasoningMarker(status)}</span><span class="intent-reasoning-step-body"><span class="intent-reasoning-summary">${escapeHtml(summary)}</span><span class="intent-reasoning-decision">${escapeHtml(decision + evidence)}</span></span></div>`;
    }).join('');
    return { html: `<details class="intent-reasoning-trace intent-waiting-surface${terminal ? ' is-terminal' : ' is-running'}" data-intent-reasoning="true"${collapsed ? '' : ' open'}><summary><span class="intent-reasoning-title${currentStatus ? ' is-current-status' : ''}">${escapeHtml(title)}</span></summary><div class="intent-reasoning-steps" role="list">${rows}</div></details>`, text: steps.map(step => humanize(step?.summary || step?.stage || '')).filter(Boolean).join('\n') };
  }
  function attachIntentReasoningTrace(node, trace = {}) {
    if (!node || typeof node.querySelector !== 'function') return false;
    const rendered = intentReasoningHtml(trace);
    const current = node.querySelector('.intent-reasoning-trace');
    if (current) { const currentStatus = String(current.querySelector('.intent-reasoning-title')?.textContent || '').trim(); current.outerHTML = intentReasoningHtml(trace, { currentStatus }).html; return true; }
    const pending = node.matches?.('.pending-feedback') ? node : node.querySelector('.pending-feedback');
    if (!pending) return false;
    const currentStatus = String(pending.textContent || '').replace(/\s+/g, ' ').trim();
    const unified = intentReasoningHtml(trace, { currentStatus });
    pending.outerHTML = unified.html;
    return true;
  }

  function isChatStatusText(value = '') {
    if (executionStatus.isExecutionStatusText?.(value)) return true;
    const text = String(value || '').trim();
    if (!text) return false;
    // Status projections are app-generated, short phrases (optionally followed
    // by the elapsed-seconds suffix). Real assistant content must never match,
    // even when it contains words like "请稍等"/"已收到"/"已等待" mid-sentence:
    // classifying real content as status previously wiped streamed answers on
    // refresh and dropped completed replies from reloaded history.
    const statusPhrase = [
      '正在执行：[^…]*',
      '正在接收任务',
      '正在准备消息',
      '正在识别任务',
      '正在连接模型',
      '正在启动图片任务',
      '正在处理中[\\s　]+请稍后',
      '正在处理',
      '正在思考',
      '正在恢复聊天任务',
      '正在等待模型生成回答',
      '正在准备执行任务',
      '正在读取当前对话上下文',
      '正在准备图片生成参数',
      '正在准备回答',
      '正在等待任务结果',
      '正在搜索网页并整理答案',
      '正在提取图片文字',
      '正在比较所选图片',
      '正在分析图片',
      '正在分析文件',
      '正在结合图片和文件分析',
      '正在准备图片',
      '正在准备文件内容',
      '正在准备图片和文件',
      '正在准备图片生成参数',
      '正在准备参考图生成任务',
      '正在准备图片修改任务',
      '正在生成图片',
      '正在修改图片',
      '正在基于参考图生成图片',
    ].join('|');
    return new RegExp('^(?:' + statusPhrase + ')(?:…)?(?:\\s*已等待\\s*\\d+\\s*秒…?)?$').test(text)
      || /^(?:已收到…?|请稍等…?|已等待\s*\d+\s*秒…?|已停止恢复…?|恢复任务不存在[\s\S]*|任务\s*\d+(?:\/\d+)?：[\s\S]*)$/.test(text);
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
    intentReasoningHtml,
    attachIntentReasoningTrace,
    isChatStatusText,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppFormatting = api;
  if (root?.window) root.window.ChatUIAppFormatting = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));










