const { buildDepartmentExportWorkbook } = require('../usage/export-xlsx');
const { DEPARTMENT_RANGE_LABELS } = require('../usage/ranges');

async function getRanking(usageStats, range) {
  return usageStats.getRanking(range);
}

async function getPersonalRange(usageStats, apiKey, range) {
  return usageStats.getPersonalRange(apiKey, range);
}

async function getUserByApiKey(usageStats, apiKey) {
  return usageStats.getUserByApiKey(apiKey);
}

async function getOverview(usageStats, apiKey, rankingRange, personalRange) {
  const [ranking, personal] = await Promise.all([
    usageStats.getRanking(rankingRange),
    apiKey ? usageStats.getPersonalRange(apiKey, personalRange) : Promise.resolve(null),
  ]);
  return { ranking, personal };
}

async function getDepartmentRanking(usageStats, range) {
  return usageStats.getDepartmentRanking(range);
}

async function getDepartmentUsers(usageStats, departmentId, range) {
  return usageStats.getDepartmentUsers(departmentId, range);
}

async function getDepartmentSummary(usageStats, range) {
  const ranking = await usageStats.getDepartmentRanking(range);
  return { ranking };
}

function groupUsersByDepartment(rows = []) {
  return rows.reduce((acc, row) => {
    const departmentId = String(row.department_id || '');
    if (!departmentId) return acc;
    const { department_id, ...user } = row;
    if (!acc[departmentId]) acc[departmentId] = [];
    acc[departmentId].push(user);
    return acc;
  }, {});
}

async function getDepartmentExportWorkbook(usageStats, range) {
  const departments = await usageStats.getDepartmentRanking(range);
  const usersByDepartment = typeof usageStats.getAllDepartmentUsers === 'function'
    ? groupUsersByDepartment(await usageStats.getAllDepartmentUsers(range))
    : Object.fromEntries(await Promise.all(departments.map(async row => [row.department_id, await usageStats.getDepartmentUsers(row.department_id, range)])));
  const rangeBounds = await usageStats.getDepartmentRangeBounds(range);
  return buildDepartmentExportWorkbook(DEPARTMENT_RANGE_LABELS[range] || '排行', departments, usersByDepartment, rangeBounds);
}

module.exports = {
  getDepartmentExportWorkbook,
  getDepartmentRanking,
  getDepartmentSummary,
  getDepartmentUsers,
  getOverview,
  getPersonalRange,
  getUserByApiKey,
  getRanking,
  groupUsersByDepartment,
};
