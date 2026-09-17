(function initChatUIJobService(root) {
  'use strict';

const http = root?.ChatUICoreHttp
  || (typeof require === 'function' ? require('../core/http') : {});
const retryableHttpStatus = http.retryableHttpStatus;
const jobEventAggregate = root?.[Symbol.for('chatui.module-registry.v1')]?.get('jobEventAggregate')
  || (typeof require === 'function' ? require('../core/job-event-aggregate') : {});

function makeClientJobId(prefix) {
  return `${prefix}-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
}

function makeClientImageJobId() {
  return makeClientJobId('imgjob');
}

function makeClientBatchJobId() {
  return makeClientJobId('imgbatch');
}

function makeClientChatJobId() {
  return makeClientJobId('chatjob');
}

function rejectedJobError(response, payload, normalizeError) {
  const error = new Error(normalizeError(null, payload));
  const statusCode = Number(response?.status) || 0;
  if (statusCode) {
    error.statusCode = statusCode;
    error.status = statusCode;
    error.retryable = retryableHttpStatus(statusCode);
  }
  const code = String(payload?.error?.code || payload?.code || '').trim();
  if (code) error.code = code;
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
  if (!response.ok) throw rejectedJobError(response, payload, normalizeError);
  return payload;
}

function postJsonWithUploadProgress({ url, body, signal, onProgress, parseResponseJson, normalizeError }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'text';
    const abort = () => {
      try { xhr.abort(); } catch {}
      reject(new DOMException('已停止', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100), event.loaded, event.total);
    };
    xhr.onload = async () => {
      signal?.removeEventListener('abort', abort);
      const responseLike = { text: async () => xhr.responseText };
      const payload = await parseResponseJson(responseLike);
      xhr.status >= 200 && xhr.status < 300
        ? resolve(payload)
        : reject(rejectedJobError({ status: xhr.status }, payload, normalizeError));
    };
    xhr.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('连接接口失败：网络请求失败'));
    };
    xhr.send(JSON.stringify(body));
  });
}

function executionProtocolFields({ requestPurpose = '', dispatchContract, bindingEvidence, submissionId = '' } = {}) {
  return {
    ...(requestPurpose ? { requestPurpose } : {}),
    ...(dispatchContract !== undefined ? { dispatchContract } : {}),
    ...(bindingEvidence !== undefined ? { bindingEvidence } : {}),
    ...(submissionId ? { submissionId: String(submissionId) } : {}),
  };
}

async function startChatJob({ payload, config, jobId, api = 'chat', headers = {}, signal, requestPurpose = '', dispatchContract, bindingEvidence, submissionId = '', fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, api, headers, ...executionProtocolFields({ requestPurpose, dispatchContract, bindingEvidence, submissionId }) },
  });
}

async function registerChatStreamJob({ payload, config, jobId, api = 'chat', start = false, headers = {}, signal, requestPurpose = '', dispatchContract, bindingEvidence, submissionId = '', fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-stream-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, api, start, headers, ...executionProtocolFields({ requestPurpose, dispatchContract, bindingEvidence, submissionId }) },
  });
}

async function getJob({ fetchImpl = fetch, url, signal, parseResponseJson, normalizeError }) {
  const response = await fetchImpl(url, { method: 'GET', signal });
  const parser = parseResponseJson || (async responseLike => {
    if (typeof responseLike?.json === 'function') return responseLike.json();
    const text = await responseLike?.text?.();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  });
  const payload = await parser(response);
  if (!response.ok) {
    const error = rejectedJobError(response, payload, normalizeError || ((_, body) => body?.error?.message || body?.message || '请求失败'));
    throw error;
  }
  return payload;
}

async function getChatJob({ jobId, fetchImpl = fetch, signal, parseResponseJson, normalizeError }) {
  if (!jobId) throw new TypeError('jobId is required');
  return getJob({
    fetchImpl,
    signal,
    parseResponseJson,
    normalizeError,
    url: `/api/chat-jobs/${encodeURIComponent(jobId)}`,
  });
}

async function abortManagedJob({ kind = 'chat', jobId, fetchImpl = fetch } = {}) {
  if (!jobId) return null;
  const collection = kind === 'image_batch' ? 'image-batches' : kind === 'image' ? 'image-jobs' : 'chat-jobs';
  const response = await fetchImpl(`/api/${collection}/${encodeURIComponent(jobId)}/abort`, {
    method: 'POST',
    keepalive: true,
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch {}
    throw rejectedJobError(
      response,
      payload,
      (_value, body) => body?.error?.message || body?.message || '停止任务失败，请重试',
    );
  }
  return response;
}

async function disposeManagedJob({ kind = 'chat', jobId, fetchImpl = fetch } = {}) {
  if (!jobId) return null;
  const collection = kind === 'image_batch' ? 'image-batches' : kind === 'image' ? 'image-jobs' : 'chat-jobs';
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
    let opened = false;
    let streaming = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(pollTimer);
      clearTimeout(reconnectTimer);
      try { reader?.cancel(); } catch {}
      fn(value);
    };
    let aggregateEvent = null;
    const normalizeCompactUpdate = event => {
      if (!event || typeof event !== 'object') return event;
      const isMinimal = Object.prototype.hasOwnProperty.call(event, 'd') || Object.prototype.hasOwnProperty.call(event, 'r') || event.done || event.e || event.z || Object.prototype.hasOwnProperty.call(event, 'ft');
      if (!isMinimal || event.data) {
        aggregateEvent = event;
        return event;
      }
      const record = { aggregate: aggregateEvent };
      const result = jobEventAggregate.applyEvent(record, event);
      if (result?.valid) aggregateEvent = result.aggregate;
      return aggregateEvent;
    };
    let updateErrorLogged = false;
    const notifyUpdate = job => {
      try {
        onUpdate(job);
      } catch (error) {
        // A UI callback failure must never swallow the canonical terminal state.
        if (!updateErrorLogged) {
          updateErrorLogged = true;
          root?.console?.warn?.('[job-waiter] update callback failed', error);
        }
      }
    };
    const handleJob = rawEvent => {
      const job = normalizeCompactUpdate(rawEvent);
      notifyUpdate(job);
      if (job.status === 'done') {
        const data = job.data && typeof job.data === 'object' ? { ...job.data, metrics: job.metrics || job.data.metrics || {} } : job.data;
        finish(resolve, data);
      } else if (job.status === 'error') finish(reject, makeTerminalJobError(job.error?.message));
    };
    const processLine = (line, buffer) => {
      if (line.startsWith('event: ')) buffer.event = line.slice(7).trim();
      else if (line.startsWith('data: ')) {
        streaming = true;
        buffer.data = (buffer.data || '') + line.slice(6);
      } else if (line === '' && buffer.data) {
        try { handleJob(JSON.parse(buffer.data)); } catch {}
        buffer.event = ''; buffer.data = '';
      }
    };
    const readStream = async (response) => {
      if (!response.ok || !response.body) {
        if (!pollJob) finish(reject, new Error('任务不存在或服务已重启，请重新发送'));
        return;
      }
      opened = true;
      const buf = { event: '', data: '' };
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
        if (leftover) processLine(leftover, buf);
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
      if (!finished) {
        if (pollJob) return;
        if (reconnects > 60) { finish(reject, new Error('任务事件连接中断，请刷新页面恢复任务；如果仍失败，请重新发送')); return; }
        reconnectTimer = setTimeout(connect, Math.min(1000 + 250 * reconnects, 5000));
      }
    };
    let pollFailures = 0;
    const poll = async () => {
      if (finished || !pollJob || pageUnloading()) return;
      let keepPolling = true;
      try {
        const job = await pollJob();
        pollFailures = 0;
        handleJob(job);
      } catch (error) {
        pollFailures += 1;
        const statusCode = Number(error?.statusCode || error?.status || 0);
        if (statusCode === 404) {
          keepPolling = false;
          finish(reject, makeTerminalJobError('任务不存在或服务已重启，请重新发送'));
        } else if (pollFailures >= 5 && !streaming) {
          keepPolling = false;
          finish(reject, new Error('任务状态获取失败，请检查网络后重试'));
        }
      }
      if (!finished && keepPolling) pollTimer = setTimeout(poll, pollIntervalMs);
    };
    abort = () => {
      if (finished) return;
      finish(reject, new DOMException('已停止', 'AbortError'));
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

async function startImageGenerationJob({ payload, config, jobId, mode = 'image', files = [], masks = [], headers = {}, signal, requestPurpose = '', dispatchContract, bindingEvidence, submissionId = '', onUploadProgress, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/image-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    onUploadProgress,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, masks, headers, ...executionProtocolFields({ requestPurpose, dispatchContract, bindingEvidence, submissionId }) },
  });
}


async function startImageBatchJob({ config, batchId, submissionId = '', tasks = [], headers = {}, signal, onUploadProgress, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/image-batches',
    signal,
    parseResponseJson,
    normalizeError,
    onUploadProgress,
    body: {
      schema_version: 'image_batch_execution.v1',
      batchId,
      submissionId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      headers,
      tasks,
    },
  });
}

async function getImageBatchJob({ batchId, fetchImpl = fetch, signal, parseResponseJson, normalizeError }) {
  const response = await fetchImpl(`/api/image-batches/${encodeURIComponent(batchId)}`, { signal });
  const payload = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, payload));
  return payload;
}

async function abortImageBatchJob({ batchId, fetchImpl = fetch }) {
  if (!batchId) return null;
  const response = await fetchImpl(`/api/image-batches/${encodeURIComponent(batchId)}/abort`, { method: 'POST' });
  return response;
}

async function disposeImageBatchJob({ batchId, fetchImpl = fetch }) {
  if (!batchId) return null;
  return fetchImpl(`/api/image-batches/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
}

const api = Object.freeze({
  makeClientJobId,
  makeClientImageJobId,
  makeClientBatchJobId,
  makeClientChatJobId,
  startChatJob,
  registerChatStreamJob,
  getJob,
  getChatJob,
  abortManagedJob,
  disposeManagedJob,
  makeTerminalJobError,
  waitJobEvent,
  startImageGenerationJob,
  startImageBatchJob,
  getImageBatchJob,
  abortImageBatchJob,
  disposeImageBatchJob,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIJobService = api;
if (root?.window) root.window.ChatUIJobService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
