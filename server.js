#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
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
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function safeJoin(root, urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const filePath = path.normalize(path.join(root, cleanPath === '/' ? 'index.html' : cleanPath));
  if (!filePath.startsWith(root)) return null;
  return filePath;
}

async function proxy(req, res) {
  try {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const baseUrl = String(body.baseUrl || '').replace(/\/$/, '');
    const apiKey = String(body.apiKey || '');
    const payload = body.payload || {};
    const method = String(body.method || 'POST').toUpperCase();

    if (!baseUrl) return send(res, 400, JSON.stringify({ error: { message: '缺少 baseUrl' } }), { 'Content-Type': 'application/json' });

    const targetPath = req.url.replace(/^\/api/, '');
    const targetUrl = `${baseUrl}${targetPath}`;

    const upstream = await fetch(targetUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
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
    send(res, 500, JSON.stringify({ error: { message: err.message || String(err) } }), { 'Content-Type': 'application/json; charset=utf-8' });
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

  if (req.url.startsWith('/api/') && req.method === 'POST') return proxy(req, res);

  const filePath = safeJoin(ROOT, req.url);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenAPI Chat Image is running locally: http://127.0.0.1:${PORT}`);
  console.log(`LAN access: http://<this-machine-ip>:${PORT}`);
});
