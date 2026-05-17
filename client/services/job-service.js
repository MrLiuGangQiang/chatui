function makeClientJobId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeClientImageJobId() {
  return makeClientJobId('imgjob');
}

function makeClientChatJobId() {
  return makeClientJobId('chatjob');
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
      xhr.status >= 200 && xhr.status < 300 ? resolve(payload) : reject(new Error(normalizeError(null, payload)));
    };
    xhr.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('连接接口失败：网络请求失败'));
    };
    xhr.send(JSON.stringify(body));
  });
}

async function startChatJob({ payload, config, jobId, headers = {}, signal, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, headers },
  });
}

async function registerChatStreamJob({ payload, config, jobId, start = false, headers = {}, signal, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/chat-stream-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, start, headers },
  });
}

async function getJob({ fetchImpl = fetch, url, parseResponseJson, normalizeError }) {
  const response = await fetchImpl(url);
  const payload = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, payload));
  return payload;
}

function waitJobEvent({ url, onUpdate = () => {}, signal, pageUnloading = () => false, EventSourceImpl = EventSource }) {
  let abort = null;
  return new Promise((resolve, reject) => {
    let source = null;
    let finished = false;
    let reconnects = 0;
    let opened = false;
    abort = () => {
      if (finished) return;
      finished = true;
      try { source?.close(); } catch {}
      reject(new DOMException('已停止', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    const connect = () => {
      if (finished) return;
      source = new EventSourceImpl(url);
      source.onopen = () => { opened = true; reconnects = 0; };
      source.addEventListener('update', event => {
        opened = true;
        const job = JSON.parse(event.data || '{}');
        onUpdate(job);
        if (job.status === 'done') {
          finished = true;
          source.close();
          resolve(job.data);
        } else if (job.status === 'error') {
          finished = true;
          source.close();
          reject(new Error(job.error?.message || '任务失败'));
        }
      });
      source.onerror = () => {
        source.close();
        if (finished || pageUnloading()) return;
        if (!opened) {
          finished = true;
          reject(new Error('任务不存在或服务已重启，请重新发送'));
          return;
        }
        reconnects += 1;
        if (reconnects > 60) {
          finished = true;
          reject(new Error('任务事件连接中断，请刷新页面恢复任务；如果仍失败，请重新发送'));
          return;
        }
        setTimeout(connect, Math.min(1000 + 250 * reconnects, 5000));
      };
    };
    connect();
  }).finally(() => { if (signal && abort) signal.removeEventListener('abort', abort); });
}

async function startImageGenerationJob({ payload, config, jobId, mode = 'image', files = [], headers = {}, signal, onUploadProgress, fetchImpl, parseResponseJson, normalizeError }) {
  return postJob({
    fetchImpl,
    url: '/api/image-jobs',
    signal,
    parseResponseJson,
    normalizeError,
    onUploadProgress,
    body: { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, headers },
  });
}

module.exports = {
  makeClientJobId,
  makeClientImageJobId,
  makeClientChatJobId,
  startChatJob,
  registerChatStreamJob,
  getJob,
  waitJobEvent,
  startImageGenerationJob,
};
