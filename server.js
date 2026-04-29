#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 50 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/images\/(generations|edits)\/?$/];
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

    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    if (!ALLOWED_PROXY_METHODS.has(method)) return sendJson(res, 405, { error: { message: '不支持的代理方法' } });

    const targetUrl = `${baseUrl}${targetPath}`;
    const upstream = await fetch(targetUrl, {
      method,
      signal: controller.signal,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
    });

    const text = await upstream.text();
    send(res, upstream.status, text, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    sendJson(res, err.statusCode || (aborted ? 504 : 500), {
      error: { message: aborted ? '上游请求超时' : (err.message || String(err)) },
    });
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
