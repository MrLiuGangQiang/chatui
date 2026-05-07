#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 50 * 1024 * 1024);
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/images\/(generations|edits)\/?$/];
const imageJobs = new Map();
const chatJobs = new Map();
const jobSubscribers = new Map();
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('请求体不是有效 JSON');
    err.statusCode = 400;
    throw err;
  }
}

function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || '');
  }
  return String(value || '');
}

function safeJoin(root, urlPath) {
  try {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
    const filePath = path.normalize(path.join(root, cleanPath === '/' ? 'index.html' : cleanPath));
    if (filePath !== root && !filePath.startsWith(ROOT_WITH_SEP)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

async function proxy(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let proxyChatJob = null;
  try {
    const targetPath = req.url.replace(/^\/api/, '').split('?')[0];
    if (!ALLOWED_PROXY_PATHS.some(re => re.test(targetPath))) {
      return sendJson(res, 403, { error: { message: '不允许代理该路径' } });
    }

    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    const method = String(body.method || 'POST').toUpperCase();
    const proxyJobId = String(body.jobId || '').trim();

    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    if (!ALLOWED_PROXY_METHODS.has(method)) return sendJson(res, 405, { error: { message: '不支持的代理方法' } });

    const targetUrl = `${baseUrl}${targetPath}`;
    const wantsStream = method !== 'GET' && payload && payload.stream === true;
    if (targetPath === '/chat/completions' && proxyJobId && wantsStream) {
      proxyChatJob = chatJobs.get(proxyJobId) || makeChatJob(proxyJobId, baseUrl, apiKey, payload, { stream: true });
      if (proxyChatJob.streamStarted) proxyChatJob = null;
      else {
        proxyChatJob.updatedAt = Date.now();
        proxyChatJob.streamStarted = true;
        chatJobs.set(proxyJobId, proxyChatJob);
        notifyJob(proxyChatJob);
      }
    }
    const upstream = await fetch(targetUrl, {
      method,
      signal: controller.signal,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(wantsStream ? { Accept: 'text/event-stream' } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
    });

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    if (wantsStream || isEventStream) {
      const chatJob = proxyChatJob;
      if (!chatJob && targetPath === '/chat/completions' && proxyJobId) {
        // 已有后台流式 job 接管时，当前页面直接通过 SSE 恢复，避免重复请求/重复输出。
        return sendJson(res, 409, { error: { message: '任务已在后台继续，请等待恢复连接' } }, { 'Access-Control-Allow-Origin': '*' });
      }
      res.writeHead(upstream.status, {
        ...SECURITY_HEADERS,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      if (!upstream.body) return res.end();
      let clientOpen = true;
      res.on('close', () => { clientOpen = false; });
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk);
        if (chatJob) updateChatJobFromStreamChunk(chatJob, buf.toString('utf8'));
        if (clientOpen && !res.destroyed) {
          try { res.write(buf); } catch { clientOpen = false; }
        }
      }
      if (chatJob) {
        chatJob.status = 'done';
        chatJob.updatedAt = Date.now();
        delete chatJob.buffer;
        notifyJob(chatJob);
      }
      if (clientOpen && !res.destroyed) res.end();
      return;
    }

    const text = await upstream.text();
    send(res, upstream.status, text, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const message = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
    if (proxyChatJob) {
      proxyChatJob.status = 'error';
      proxyChatJob.error = message;
      proxyChatJob.updatedAt = Date.now();
      notifyJob(proxyChatJob);
    }
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, err.statusCode || (aborted ? 504 : 502), { error: { message } });
    } else if (!res.destroyed) {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function proxyImage(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const imageUrl = new URL(String(body.url || '').trim());
    const base = new URL(baseUrl);

    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return sendJson(res, 400, { error: { message: '非法图片地址' } });
    if (imageUrl.origin !== base.origin) return sendJson(res, 403, { error: { message: '只允许代理同源图片地址' } });

    const upstream = await fetch(imageUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      return sendJson(res, upstream.status, { error: { message: text || '图片下载失败' } });
    }
    if (!contentType.startsWith('image/')) {
      return sendJson(res, 415, { error: { message: '上游返回的不是图片' } });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, buffer, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    sendJson(res, err.statusCode || (aborted ? 504 : 500), {
      error: { message: aborted ? '图片下载超时' : (err.message || String(err)) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function makeJobId(value = '') {
  const supplied = String(value || '').trim();
  if (/^(imgjob|chatjob)-[a-z0-9-]{8,80}$/i.test(supplied)) return supplied;
  return `imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}


function makeChatJob(jobId, baseUrl, apiKey, payload, { stream = true } = {}) {
  return {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}/chat/completions`,
    apiKey,
    payload: stream ? { ...payload, stream: true } : { ...payload, stream: false },
    data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
    error: '',
    buffer: '',
    streamStarted: false,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: job.data || null,
    error: job.error ? { message: job.error } : null,
  };
}

function notifyJob(job) {
  const subscribers = jobSubscribers.get(job.id);
  if (!subscribers) return;
  const data = `event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of subscribers) res.write(data);
  if (job.status === 'done' || job.status === 'error') {
    for (const res of subscribers) res.end();
    jobSubscribers.delete(job.id);
  }
}

function subscribeJob(req, res, store) {
  const id = getJobIdFromUrl(req);
  const job = store.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  if (!jobSubscribers.has(id)) jobSubscribers.set(id, new Set());
  jobSubscribers.get(id).add(res);
  req.on('close', () => {
    const set = jobSubscribers.get(id);
    if (!set) return;
    set.delete(res);
    if (!set.size) jobSubscribers.delete(id);
  });
}

async function runImageJob(job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify(job.payload),
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    job.status = 'done';
    job.data = data;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
    job.updatedAt = Date.now();
    notifyJob(job);
  }
}

async function startImageJob(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    const jobId = makeJobId(body.jobId);
    if (imageJobs.has(jobId)) return sendJson(res, 200, publicJob(imageJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
    const job = {
      id: jobId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetUrl: `${baseUrl}/images/generations`,
      apiKey,
      payload,
      data: null,
      error: '',
    };
    imageJobs.set(job.id, job);
    runImageJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

function getJobIdFromUrl(req) {
  return decodeURIComponent(req.url.split('?')[0].split('/').filter(Boolean).at(-1) === 'events'
    ? req.url.split('?')[0].split('/').filter(Boolean).at(-2) || ''
    : req.url.split('?')[0].split('/').filter(Boolean).at(-1) || '');
}

function getImageJob(req, res) {
  const id = getJobIdFromUrl(req);
  const job = imageJobs.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}

async function runChatJob(job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify(job.payload),
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    job.status = 'done';
    job.data = data;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
    job.updatedAt = Date.now();
    notifyJob(job);
  }
}

async function runChatStreamJob(job) {
  if (job.streamStarted) return;
  job.streamStarted = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...job.payload, stream: true }),
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    }
    if (!upstream.body) throw new Error('上游没有返回流式响应体');
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await upstream.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      const content = data?.choices?.[0]?.message?.content || data?.output_text || data?.raw || '';
      const msg = data?.choices?.[0]?.message || {};
      const reasoning = normalizeReasoningText(msg.reasoning_content || msg.reasoning || msg.thinking || msg.reasoning_details || msg.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || '');
      job.data = { choices: [{ message: { content, reasoning_content: reasoning } }] };
    } else {
      for await (const chunk of upstream.body) {
        updateChatJobFromStreamChunk(job, Buffer.from(chunk).toString('utf8'));
      }
    }
    job.status = 'done';
    delete job.buffer;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
    job.updatedAt = Date.now();
    notifyJob(job);
  }
}

async function registerChatStreamJob(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
    let job = chatJobs.get(jobId);
    if (!job) {
      job = makeChatJob(jobId, baseUrl, apiKey, payload, { stream: true });
      chatJobs.set(jobId, job);
    }
    if (body.start === true && !job.streamStarted && job.status === 'running') runChatStreamJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

async function startChatJob(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
    if (chatJobs.has(jobId)) return sendJson(res, 200, publicJob(chatJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
    const job = {
      id: jobId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetUrl: `${baseUrl}/chat/completions`,
      apiKey,
      payload: { ...payload, stream: false },
      data: null,
      error: '',
    };
    chatJobs.set(job.id, job);
    runChatJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

function getChatJob(req, res) {
  const id = getJobIdFromUrl(req);
  const job = chatJobs.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}

function updateChatJobFromStreamChunk(job, text) {
  job.buffer = (job.buffer || '') + text;
  const lines = job.buffer.split(/\r?\n/);
  job.buffer = lines.pop() || '';
  const message = job.data.choices[0].message;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataText = trimmed.slice(5).trim();
    if (!dataText || dataText === '[DONE]') continue;
    try {
      const data = JSON.parse(dataText);
      const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {};
      const content = delta.content || (typeof data?.content === 'string' ? data.content : '');
      const reasoning = normalizeReasoningText(delta.reasoning_content || delta.reasoning || delta.thinking || delta.reasoning_details || delta.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || '');
      if (content) message.content += content;
      if (reasoning) message.reasoning_content += reasoning;
      job.updatedAt = Date.now();
      if (content || reasoning) notifyJob(job);
    } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
  }

  if (req.url === '/api/image') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return proxyImage(req, res);
  }

  if (req.url === '/api/image-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return startImageJob(req, res);
  }

  if (req.url === '/api/chat-stream-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return registerChatStreamJob(req, res);
  }

  if (req.url === '/api/chat-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return startChatJob(req, res);
  }

  if (req.url.startsWith('/api/chat-jobs/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    if (req.url.endsWith('/events')) return subscribeJob(req, res, chatJobs);
    return getChatJob(req, res);
  }

  if (req.url.startsWith('/api/image-jobs/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    if (req.url.endsWith('/events')) return subscribeJob(req, res, imageJobs);
    return getImageJob(req, res);
  }

  if (req.url.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return proxy(req, res);
  }

  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');

  const filePath = safeJoin(ROOT, req.url);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') || filePath.endsWith('.js') || filePath.endsWith('.css') ? 'no-cache' : 'public, max-age=3600',
    };
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    send(res, 200, data, headers);
  });
});

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAPI Chat Image is running locally: http://127.0.0.1:${PORT}`);
  console.log(`LAN access: http://<this-machine-ip>:${PORT}`);
  console.log(`Listening on: ${HOST}:${PORT}`);
});
