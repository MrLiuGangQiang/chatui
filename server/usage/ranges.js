const sharedRanges = require('../../shared/usage/ranges');

const {
  RANGE_DEFINITIONS,
  PERSONAL_RANGES,
  DEPARTMENT_RANGES,
  rangeLabel,
  rangeShortLabel,
  rangeTabs,
} = sharedRanges;

// SQL is deliberately server-owned.  This module is never bundled into the
// browser, while shared/usage/ranges.js only carries labels and range keys.
// Keeping table/column names out of shared code prevents schema details from
// becoming part of the public static asset contract.
function normalizeUsageTimeZone(value, fallback = 'Asia/Shanghai') {
  const candidate = String(value || '').trim();
  if (!candidate || !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(candidate)) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return fallback;
  }
}

const USAGE_TIME_ZONE = normalizeUsageTimeZone(process.env.USAGE_TIME_ZONE);
const LOCAL_NOW_SQL = `(NOW() AT TIME ZONE '${USAGE_TIME_ZONE}')`;
function zonedBoundary(unit, offset = '') {
  const shifted = `${`date_trunc('${unit}', ${LOCAL_NOW_SQL})`}${offset ? ` ${offset}` : ''}`;
  return `((${shifted}) AT TIME ZONE '${USAGE_TIME_ZONE}')`;
}
const DAY_START = zonedBoundary('day');
const YESTERDAY_START = zonedBoundary('day', "- INTERVAL '1 day'");
const WEEK_START = zonedBoundary('week');
const LAST_WEEK_START = zonedBoundary('week', "- INTERVAL '1 week'");
const MONTH_START = zonedBoundary('month');
const LAST_MONTH_START = zonedBoundary('month', "- INTERVAL '1 month'");

const RANGE_FILTERS = Object.freeze({
  today: `ul.created_at >= ${DAY_START} AND ul.created_at <= NOW()`,
  yesterday: `ul.created_at >= ${YESTERDAY_START} AND ul.created_at < ${DAY_START}`,
  week: `ul.created_at >= ${WEEK_START} AND ul.created_at <= NOW()`,
  last_week: `ul.created_at >= ${LAST_WEEK_START} AND ul.created_at < ${WEEK_START}`,
  month: `ul.created_at >= ${MONTH_START} AND ul.created_at <= NOW()`,
  last_month: `ul.created_at >= ${LAST_MONTH_START} AND ul.created_at < ${MONTH_START}`,
  total: 'TRUE',
});

const DEPARTMENT_RANGE_FILTERS = RANGE_FILTERS;
const DEPARTMENT_RANGE_BOUNDS_SQL = Object.freeze({
  today: `SELECT ${DAY_START} AS start_time, NOW() AS end_time`,
  yesterday: `SELECT ${YESTERDAY_START} AS start_time, ${DAY_START} AS end_time`,
  week: `SELECT ${WEEK_START} AS start_time, NOW() AS end_time`,
  last_week: `SELECT ${LAST_WEEK_START} AS start_time, ${WEEK_START} AS end_time`,
  month: `SELECT ${MONTH_START} AS start_time, NOW() AS end_time`,
  last_month: `SELECT ${LAST_MONTH_START} AS start_time, ${MONTH_START} AS end_time`,
  total: `SELECT MIN(created_at) AS start_time, NOW() AS end_time FROM usage_logs`,
});
const DEPARTMENT_RANGE_LABELS = sharedRanges.pickRangeField(DEPARTMENT_RANGES, 'label');

function isPersonalRange(range) {
  return PERSONAL_RANGES.includes(range);
}

function isDepartmentRange(range) {
  return DEPARTMENT_RANGES.includes(range);
}

module.exports = {
  RANGE_DEFINITIONS,
  PERSONAL_RANGES,
  DEPARTMENT_RANGES,
  RANGE_FILTERS,
  DEPARTMENT_RANGE_FILTERS,
  DEPARTMENT_RANGE_BOUNDS_SQL,
  DEPARTMENT_RANGE_LABELS,
  USAGE_TIME_ZONE,
  normalizeUsageTimeZone,
  zonedBoundary,
  isPersonalRange,
  isDepartmentRange,
  rangeLabel,
  rangeShortLabel,
  rangeTabs,
};
