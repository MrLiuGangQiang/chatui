const { createUsageController, isDepartmentPasswordValid } = require('../controllers/usage.controller');

function createUsageRoutes({ sendJson, sendMethodNotAllowed, usageStats, send }) {
  const controller = createUsageController({ sendJson, sendMethodNotAllowed, usageStats, send });

  function routeUsage(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/api/usage/overview') return controller.routeOverview(req, res);
    if (pathname === '/api/usage/rankings') return controller.routeRankings(req, res);
    if (pathname === '/api/usage/personal') return controller.routePersonal(req, res);
    if (pathname === '/api/usage/department/verify') return controller.routeDepartmentVerify(req, res);
    if (pathname === '/api/usage/department/summary') return controller.routeDepartmentSummary(req, res);
    if (pathname === '/api/usage/department/rankings') return controller.routeDepartmentRankings(req, res);
    if (pathname === '/api/usage/department/users') return controller.routeDepartmentUsers(req, res);
    if (pathname === '/api/usage/department/export') return controller.routeDepartmentExport(req, res);
    return sendJson(res, 404, { error: { message: '未找到使用统计接口' } }, { 'Access-Control-Allow-Origin': '*' });
  }

  return { routeUsage };
}

module.exports = { createUsageRoutes, isDepartmentPasswordValid };
