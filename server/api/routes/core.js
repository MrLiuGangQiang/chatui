function createCoreRoutes({ appVersion, sendJson, sendMethodNotAllowed, proxyImage, extractFileText, registerChatStreamJob }) {
  function routeCoreApi(req, res) {
    if (req.url === '/api/version') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res);
      return sendJson(res, 200, { version: appVersion }, { 'Access-Control-Allow-Origin': '*' });
    }

    if (req.url === '/api/image') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return proxyImage(req, res);
    }

    if (req.url === '/api/chat-stream-jobs') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return registerChatStreamJob(req, res);
    }

    if (req.url === '/api/extract-file') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return extractFileText(req, res);
    }

    return false;
  }

  return { routeCoreApi };
}

module.exports = { createCoreRoutes };
