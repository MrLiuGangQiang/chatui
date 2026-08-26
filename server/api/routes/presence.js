'use strict';

const { readBody, parseJson } = require('../../http/body');
const { PRESENCE_KEEPALIVE_INTERVAL_MS } = require('../../services/presence.service');
const { SECURITY_HEADERS, sendJson, sendMethodNotAllowed } = require('../../http/response');
const { JOB_SSE_HEADERS } = require('../../jobs/http-contract');

const PRESENCE_STREAM_MAX_CLIENT_ID_BYTES = 1024;

function presenceUnavailable(res, sendJson) {
  return sendJson(res, 503, {
    available: false,
    reason: 'Presence service unavailable',
    count: 0,
  }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
}

function createPresenceRoutes({ presence, sendJson, sendMethodNotAllowed }) {
  const service = presence || null;

  function routePresence(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/api/presence') return routeSnapshot(req, res);
    if (pathname === '/api/presence/stream') return routeStream(req, res);
    if (pathname === '/api/presence/heartbeat') return routeHeartbeat(req, res);
    return sendJson(res, 404, { error: { message: 'Presence endpoint not found' } }, { 'Access-Control-Allow-Origin': '*' });
  }

  function routeSnapshot(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (!service) return presenceUnavailable(res, sendJson);
    return sendJson(res, 200, service.snapshot(), {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
  }

  function routeStream(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (!service) return presenceUnavailable(res, sendJson);
    let clientId = '';
    try {
      clientId = new URL(req.url, 'http://chatui.local').searchParams.get('clientId') || '';
    } catch {}
    const normalized = service.normalizeClientId(clientId);
    if (!normalized) {
      return sendJson(res, 400, { error: { message: 'Valid clientId query parameter is required' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    res.writeHead(200, { ...SECURITY_HEADERS, ...JOB_SSE_HEADERS });
    res.write(`event: presence\ndata: ${JSON.stringify(service.snapshot())}\n\n`);
    res.flushHeaders?.();
    const joined = service.join(normalized, res);
    if (!joined) {
      try { res.end(); } catch {}
      return;
    }
    // Proxy/lb timeouts can kill an otherwise idle SSE connection; a comment
    // frame every few seconds keeps the stream alive without client work.
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
        res.flushHeaders?.();
      } catch {}
    }, PRESENCE_KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      service.leave(normalized, res);
    });
  }

  async function routeHeartbeat(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    if (!service) return presenceUnavailable(res, sendJson);
    let body = null;
    try {
      body = parseJson(await readBody(req, { maxBytes: PRESENCE_STREAM_MAX_CLIENT_ID_BYTES }));
    } catch (error) {
      return sendJson(res, Number(error?.statusCode) || 400, { error: { message: 'Invalid presence heartbeat body' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    const clientId = service.normalizeClientId(body?.clientId);
    if (!clientId) {
      return sendJson(res, 400, { error: { message: 'Valid clientId is required' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    service.touch(clientId);
    return sendJson(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  }

  return { routePresence };
}

module.exports = { createPresenceRoutes };