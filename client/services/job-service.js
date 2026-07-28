(function initChatUIJobService(root) {
  'use strict';

function makeClientJobId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeClientImageJobId() {
  return makeClientJobId('imgjob');
}

function makeClientChatJobId() {
  return makeClientJobId('chatjob');
}

function makeAbortError() {
  if (typeof root?.DOMException === 'function') return new root.DOMException('已停止', 'AbortError');
  const error = new Error('已停止');
  error.name = 'AbortError';
  return error;
}

async function postJob({ fetchImpl = fetch, url, body, signal, parseResponseJson, normalizeError, onUploadProgress }) {
  if (onUploadProgress) return postJsonWithUploadProgress({ url, body, signal, onProgress: onUploadProgress, parseResponseJson, normalizeError });
  const response = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, payload));
  return payload;
}

function postJsonWithUploadProgress({ url, body, signal, onProgress, parseResponseJson, normalizeError }) {
  return new Promise((resolve, reject) => {
    const XMLHttpRequestImpl = root?.XMLHttpRequest;
    if (typeof XMLHttpRequestImpl !== 'function') {
      reject(new Error('XMLHttpRequest unavailable'));
      return;
    }
    const xhr = new XMLHttpRequestImpl();
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'text';
    const abort = () => {
      try { xhr.abort(); } catch {}
      settle(reject, makeAbortError());
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (xhr.upload) xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      try { onProgress?.(Math.round(event.loaded / event.total * 100), event.loaded, event.total); } catch {}
    };
    xhr.onload = async () => {
      try {
        const responseLike = { text: async () => xhr.responseText };
        const payload = await parseResponseJson(responseLike);
        if (xhr.status >= 200 && xhr.status < 300) settle(resolve, payload);
        else settle(reject, new Error(normalizeError(null, payload)));
      } catch (error) {
        settle(reject, error);
      }
    };
    xhr.onerror = () => settle(reject, new Error('连接接口失败：网络请求失败'));
    xhr.onabort = () => settle(reject, makeAbortError());
    try { xhr.send(JSON.stringify(body)); } catch (error) { settle(reject, error); }
  });
}

async function startChatJob({ payload, config, jobId, api = 'chat', headers = {}, signal, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, api, headers },
  });
}

async function registerChatStreamJob({ payload, config, jobId, api = 'chat', start = false, headers = {}, signal, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-stream-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, api, start, headers },
  });
}

async function getJob({ fetchImpl = fetch, url, parseResponseJson, normalizeError }) {
  const response = await fetchImpl(url);
  const payload = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, payload));
  return payload;
}

async function abortManagedJob({ kind = 'chat', jobId, fetchImpl = fetch } = {}) {
  if (!jobId) return null;
  const collection = kind === 'image' ? 'image-jobs' : 'chat-jobs';
  const response = await fetchImpl(`/api/${collection}/${encodeURIComponent(jobId)}/abort`, { method: 'POST' });
  return response;
}

async function disposeManagedJob({ kind = 'chat', jobId, fetchImpl = fetch } = {}) {
  if (!jobId) return null;
  const collection = kind === 'image' ? 'image-jobs' : 'chat-jobs';
  return fetchImpl(`/api/${collection}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

function makeTerminalJobError(message = 'Managed job failed') {
  const error = new Error(message || 'Managed job failed');
  error.name = 'JobTerminalError';
  error.terminalJob = true;
  return error;
}

function waitJobEvent({ url, onUpdate = () => {}, signal, pageUnloading = () => false, fetchImpl = fetch, pollJob = null, pollIntervalMs = 2500 }) {
  let abort = null;
  let pollTimer = null;
  return new Promise((resolve, reject) => {
    let finished = false;
    let reader = null;
    let reconnectTimer = null;
    let reconnects = 0;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(pollTimer);
      clearTimeout(reconnectTimer);
      try { reader?.cancel(); } catch {}
      fn(value);
    };
    const handleJob = job => {
      try { onUpdate(job); } catch (error) {
        try { root?.console?.warn?.('[job] update callback failed', error); } catch {}
      }
      if (job.status === 'done') {
        const data = job.data && typeof job.data === 'object' ? { ...job.data, metrics: job.metrics || job.data.metrics || {} } : job.data;
        finish(resolve, data);
      } else if (job.status === 'error') finish(reject, makeTerminalJobError(job.error?.message));
    };
    const dispatchBuffer = buffer => {
      if (!buffer.data.length) return;
      const data = buffer.data.join('\n');
      buffer.event = '';
      buffer.data = [];
      try { handleJob(JSON.parse(data)); } catch {}
    };
    const processLine = (line, buffer) => {
      const normalized = String(line || '').replace(/\r$/, '');
      if (!normalized) return dispatchBuffer(buffer);
      if (normalized.startsWith(':')) return;
      const separator = normalized.indexOf(':');
      const field = separator === -1 ? normalized : normalized.slice(0, separator);
      let value = separator === -1 ? '' : normalized.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') buffer.event = value;
      else if (field === 'data') buffer.data.push(value);
    };
    const readStream = async (response) => {
      if (!response.ok || !response.body) {
        if (!pollJob) finish(reject, new Error('任务不存在或服务已重启，请重新发送'));
        return;
      }
      const buf = { event: '', data: [] };
      const decoder = new TextDecoder();
      reader = response.body.getReader();
      let leftover = '';
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          leftover += decoder.decode(value, { stream: true });
          const lines = leftover.split('\n');
          leftover = lines.pop() || '';
          for (const line of lines) processLine(line, buf);
        }
        leftover += decoder.decode();
        if (leftover) processLine(leftover, buf);
        if (!finished) dispatchBuffer(buf);
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
      if (!finished) {
        if (pollJob) return;
        if (reconnects > 60) { finish(reject, new Error('任务事件连接中断，请刷新页面恢复任务；如果仍失败，请重新发送')); return; }
        reconnectTimer = setTimeout(connect, Math.min(1000 + 250 * reconnects, 5000));
      }
    };
    const poll = async () => {
      if (finished || !pollJob || pageUnloading()) return;
      try { handleJob(await pollJob()); } catch {}
      if (!finished) pollTimer = setTimeout(poll, pollIntervalMs);
    };
    abort = () => {
      if (finished) return;
      finish(reject, makeAbortError());
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    poll();
    const connect = () => {
      if (finished) return;
      reconnects += 1;
      fetchImpl(url, { signal, headers: { Accept: 'text/event-stream' } })
        .then(response => readStream(response))
        .catch(err => {
          if (finished || pageUnloading()) return;
          if (err.name === 'AbortError') return;
          if (!pollJob) {
            if (reconnects <= 1) finish(reject, new Error('任务不存在或服务已重启，请重新发送'));
            else if (reconnects > 60) finish(reject, new Error('任务事件连接中断，请刷新页面恢复任务；如果仍失败，请重新发送'));
            else reconnectTimer = setTimeout(connect, Math.min(1000 + 250 * reconnects, 5000));
          }
        });
    };
    connect();
  }).finally(() => {
    clearTimeout(pollTimer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  });
}

async function startImageGenerationJob({ payload, config, jobId, mode = 'image', files = [], masks = [], headers = {}, signal, onUploadProgress, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/image-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    onUploadProgress,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, masks, headers },
  });
}

const api = Object.freeze({
  makeClientJobId,
  makeClientImageJobId,
  makeClientChatJobId,
  startChatJob,
  registerChatStreamJob,
  getJob,
  abortManagedJob,
  disposeManagedJob,
  makeTerminalJobError,
  waitJobEvent,
  startImageGenerationJob,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIJobService = api;
if (root?.window) root.window.ChatUIJobService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
