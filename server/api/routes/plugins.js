'use strict';

const { sendJson } = require('../../http/response');

function createPluginRoutes({ pluginService }) {
  function routePlugins(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname !== '/api/plugins') {
      return sendJson(res, 404, { error: { code: 'PLUGIN_NOT_FOUND', message: '插件不存在' } }, { 'Cache-Control': 'no-store' });
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } }, { 'Cache-Control': 'no-store' });
    }
    return sendJson(res, 200, { plugins: pluginService.publicPlugins() }, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }

  return { routePlugins };
}

module.exports = { createPluginRoutes };
