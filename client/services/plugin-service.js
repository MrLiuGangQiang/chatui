(function initChatUIPluginService(root) {
  'use strict';

  const SELECTED_TOOLS_KEY = 'chatui.plugins.selected-tools.v1';

  function selectedToolIds(storage = root?.localStorage) {
    try {
      const raw = storage?.getItem?.(SELECTED_TOOLS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return (Array.isArray(parsed) ? parsed : []).map(item => String(item || '').trim()).filter(Boolean).slice(0, 32);
    } catch {
      return [];
    }
  }

  function saveSelectedToolIds(ids = [], storage = root?.localStorage) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 32);
    try { storage?.setItem?.(SELECTED_TOOLS_KEY, JSON.stringify(normalized)); } catch {}
    return normalized;
  }

  async function listPlugins(fetchImpl = root?.fetch?.bind?.(root)) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    const response = await fetchImpl('/api/plugins', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || '插件配置暂时不可用，请稍后重试');
      error.code = payload?.error?.code || 'PLUGINS_REQUEST_FAILED';
      error.statusCode = response.status;
      throw error;
    }
    const plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
    return plugins.filter(plugin => plugin && plugin.enabled !== false);
  }

  function extractChatResult(job = {}) {
    const message = job?.data?.choices?.[0]?.message || {};
    return {
      content: String(message.content || job?.data?.content || ''),
      reasoning: String(message.reasoning_content || message.reasoning || ''),
      metrics: job?.metrics || {},
      pluginTrace: Array.isArray(job?.pluginTrace) ? job.pluginTrace : [],
    };
  }

  async function requestJobError(response) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message || '插件聊天任务创建失败，请稍后重试');
    error.code = payload?.error?.code || 'PLUGIN_CHAT_JOB_FAILED';
    error.statusCode = response.status;
    return error;
  }

  async function releaseJob(fetchImpl, jobId) {
    if (!jobId) return;
    try { await fetchImpl(`/api/chat-jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }); } catch {}
  }

  async function runPluginChat(options = {}) {
    const fetchImpl = options.fetch || root?.fetch?.bind?.(root);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    const selected = selectedToolIds(options.storage);
    if (!selected.length) throw new Error('请先选择至少一个可自动调用的插件工具');
    const body = {
      jobId: options.jobId,
      baseUrl: options.config?.baseUrl,
      apiKey: options.config?.apiKey,
      api: 'chat',
      payload: {
        model: options.model,
        messages: Array.isArray(options.messages) ? options.messages : [],
        stream: false,
      },
      pluginToolIds: selected,
      ...(options.requestPurpose ? { requestPurpose: options.requestPurpose } : {}),
      ...(options.dispatchContract !== undefined ? { dispatchContract: options.dispatchContract } : {}),
      ...(options.bindingEvidence !== undefined ? { bindingEvidence: options.bindingEvidence } : {}),
      ...(options.submissionId ? { submissionId: String(options.submissionId) } : {}),
    };
    const startedAt = Date.now();
    const response = await fetchImpl('/api/chat-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) throw await requestJobError(response);
    let job = await response.json().catch(() => null);
    const jobId = job?.id || options.jobId || '';
    for (;;) {
      if (options.signal?.aborted) {
        await releaseJob(fetchImpl, jobId);
        const abort = new Error('已停止');
        abort.name = 'AbortError';
        throw abort;
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      const next = await fetchImpl(`/api/chat-jobs/${encodeURIComponent(jobId)}`, {
        headers: { Accept: 'application/json' },
        signal: options.signal,
      });
      if (!next.ok) throw await requestJobError(next);
      job = await next.json().catch(() => null);
      if (job?.status === 'error') {
        const error = new Error(job?.error?.message || '插件聊天任务失败，请稍后重试');
        error.code = job?.error?.code || 'PLUGIN_CHAT_JOB_FAILED';
        throw error;
      }
      if (job?.status === 'done') {
        const result = extractChatResult(job);
        result.metrics = {
          ...result.metrics,
          durationMs: Number.isFinite(result.metrics?.durationMs) ? result.metrics.durationMs : Date.now() - startedAt,
        };
        return result;
      }
    }
  }

  const api = Object.freeze({
    SELECTED_TOOLS_KEY,
    selectedToolIds,
    saveSelectedToolIds,
    listPlugins,
    runPluginChat,
    extractChatResult,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get?.('moduleRegistry')?.register('pluginService', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
