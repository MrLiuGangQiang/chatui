(function () {
  async function requestModels(options) {
    const core = window.ChatUICore || {};
    const http = core.http || {};
    const fetchImpl = options && options.fetchImpl || window.fetch.bind(window);
    const baseUrl = options && options.baseUrl || '';
    const apiKey = options && options.apiKey || '';
    if (!baseUrl) throw new Error('请先配置 Endpoint Base URL');
    let response;
    try {
      response = await fetchImpl('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, query: {}, payload: {}, method: 'GET' }),
      });
    } catch (err) {
      throw new Error(`连接接口失败：${err && err.message || '网络请求失败'}`);
    }
    const parse = http.parseResponseJson || (async res => {
      const text = await res.text();
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
    });
    const normalize = http.normalizeError || ((err, payload) => payload && payload.error && payload.error.message || err && err.message || '请求失败');
    const payload = await parse(response);
    if (!response.ok) throw new Error(normalize(null, payload));
    return payload;
  }



  function makeClientJobId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const makeClientImageJobId = () => makeClientJobId('imgjob');
  const makeClientChatJobId = () => makeClientJobId('chatjob');

  function serviceDeps() {
    const http = window.ChatUICore && window.ChatUICore.http || {};
    return {
      parseResponseJson: http.parseResponseJson || (async res => {
        const text = await res.text();
        try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
      }),
      normalizeError: http.normalizeError || ((err, payload) => payload && payload.error && payload.error.message || err && err.message || '请求失败'),
    };
  }

  async function postJob(url, body, options) {
    const deps = serviceDeps();
    const response = await (options && options.fetchImpl || window.fetch.bind(window))(url, {
      method: 'POST',
      signal: options && options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await deps.parseResponseJson(response);
    if (!response.ok) throw new Error(deps.normalizeError(null, payload));
    return payload;
  }

  async function startChatJob({ payload, config, jobId, headers = {}, signal, fetchImpl }) {
    return postJob('/api/chat-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, headers }, { signal, fetchImpl });
  }

  async function registerChatStreamJob({ payload, config, jobId, start = false, headers = {}, signal, fetchImpl }) {
    return postJob('/api/chat-stream-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, start, headers }, { signal, fetchImpl });
  }

  async function getJob({ url, fetchImpl }) {
    const deps = serviceDeps();
    const response = await (fetchImpl || window.fetch.bind(window))(url);
    const payload = await deps.parseResponseJson(response);
    if (!response.ok) throw new Error(deps.normalizeError(null, payload));
    return payload;
  }

  async function startImageGenerationJob({ payload, config, jobId, mode = 'image', files = [], headers = {}, signal, onUploadProgress, fetchImpl }) {
    if (onUploadProgress) {
      return new Promise((resolve, reject) => {
        const deps = serviceDeps();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/image-jobs');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'text';
        const abort = () => { try { xhr.abort(); } catch {} reject(new DOMException('已停止', 'AbortError')); };
        if (signal && signal.aborted) return abort();
        signal && signal.addEventListener('abort', abort, { once: true });
        xhr.upload.onprogress = event => event.lengthComputable && onUploadProgress(Math.round(event.loaded / event.total * 100), event.loaded, event.total);
        xhr.onload = async () => {
          signal && signal.removeEventListener('abort', abort);
          const payload = await deps.parseResponseJson({ text: async () => xhr.responseText });
          xhr.status >= 200 && xhr.status < 300 ? resolve(payload) : reject(new Error(deps.normalizeError(null, payload)));
        };
        xhr.onerror = () => { signal && signal.removeEventListener('abort', abort); reject(new Error('连接接口失败：网络请求失败')); };
        xhr.send(JSON.stringify({ jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, headers }));
      });
    }
    return postJob('/api/image-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, headers }, { signal, fetchImpl });
  }



  function extractChatJobText(data) {
    const message = data && data.choices && data.choices[0] && data.choices[0].message || {};
    return {
      content: message.content || data && data.output_text || '',
      reasoning: message.reasoning_content || message.reasoning || data && data.reasoning_content || data && data.reasoning || '',
    };
  }

  async function requestJson({ url, payload, apiKey = '', directMode = false, baseUrl = '', method = 'POST', headers = {}, signal, fetchImpl }) {
    const deps = serviceDeps();
    const coreHttp = window.ChatUICore && window.ChatUICore.http || {};
    const targetUrl = directMode ? url : coreHttp.toProxyUrl ? coreHttp.toProxyUrl(url, baseUrl) : url.startsWith(baseUrl) ? `/api${url.slice(baseUrl.length)}` : url;
    const body = directMode ? payload : { baseUrl, apiKey, payload, method, headers };
    let response;
    try {
      response = await (fetchImpl || window.fetch.bind(window))(targetUrl, {
        method,
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(directMode ? headers : {}),
          ...(directMode && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new Error(`连接接口失败：${err && err.message || '网络请求失败'}`);
    }
    const parsed = await deps.parseResponseJson(response);
    if (!response.ok) throw new Error(deps.normalizeError(null, parsed));
    return parsed;
  }

  function parseSseLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return { done: true };
    const reasoning = window.ChatUICore && window.ChatUICore.reasoning || {};
    return { done: false, delta: (reasoning.extractStreamDelta || (() => ({})))(JSON.parse(data)) };
  }



  function extractImageResult(result) {
    const item = result && result.data && result.data[0] || null;
    if (!item) return { kind: 'empty', url: '', b64: '', raw: JSON.stringify(result, null, 2) };
    const url = item.url || '';
    const b64 = item.b64_json || item.image_base64 || '';
    const src = url || (b64 ? `data:image/png;base64,${b64}` : '');
    return src ? { kind: 'image', src, url, b64, raw: url || '[base64 image]' } : { kind: 'raw', url: '', b64: '', raw: JSON.stringify(result, null, 2) };
  }

  function buildImageCompletionMessage({ prompt = '', mode = 'image' } = {}) {
    return mode === 'edit_image' ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
  }

  async function imageFileToJobPayload(attachment, readFileAsDataURL) {
    const file = attachment && attachment.file;
    if (!file) return null;
    const dataUrl = await readFileAsDataURL(file);
    const data = String(dataUrl || '').split(',')[1] || '';
    return data ? { name: attachment.name || file.name || 'image.png', type: attachment.type || file.type || 'image/png', data } : null;
  }

  async function imageFilesToJobPayload(attachments, readFileAsDataURL) {
    const result = [];
    for (const attachment of attachments || []) {
      const payload = await imageFileToJobPayload(attachment, readFileAsDataURL);
      if (payload) result.push(payload);
    }
    return result;
  }

  window.ChatUIServices = Object.freeze({
    ...(window.ChatUIServices || {}),
    models: Object.freeze({ requestModels }),
    jobs: Object.freeze({ makeClientImageJobId, makeClientChatJobId, startChatJob, registerChatStreamJob, getJob, startImageGenerationJob }),
    chat: Object.freeze({ extractChatJobText, requestJson, parseSseLine }),
    images: Object.freeze({ extractImageResult, buildImageCompletionMessage, imageFileToJobPayload, imageFilesToJobPayload }),
  });
})();
