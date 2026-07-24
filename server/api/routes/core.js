function createCoreRoutes({ appVersion, readPublicConfig, sendJson, sendMethodNotAllowed, proxyImage, extractFileText, registerChatStreamJob }) {
  const routes = [
    {
      path: '/api/version',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, { version: appVersion }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/config/public',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, { version: appVersion, config: readPublicConfig() }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/image',
      method: 'POST',
      handler: proxyImage,
    },
    {
      path: '/api/chat-stream-jobs',
      method: 'POST',
      handler: registerChatStreamJob,
    },
    {
      path: '/api/extract-file',
      method: 'POST',
      handler: extractFileText,
    },
  ];

  function routeCoreApi(req, res) {
    const route = routes.find(item => item.path === (req.pathname || req.url));
    if (!route) return false;
    if (req.method !== route.method) return sendMethodNotAllowed(res);
    return route.handler(req, res);
  }

  return { routeCoreApi };
}

module.exports = { createCoreRoutes };
