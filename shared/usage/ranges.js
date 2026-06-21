(function initChatUIUsageRanges(root) {
  'use strict';

  const RANGE_DEFINITIONS = Object.freeze({
    today: Object.freeze({
      label: '今日排行',
      shortLabel: '今日',
      filter: `ul.created_at >= CURRENT_DATE::timestamptz AND ul.created_at <= NOW()`,
      boundsSql: `SELECT CURRENT_DATE::timestamptz AS start_time, NOW() AS end_time`,
    }),
    yesterday: Object.freeze({
      label: '昨日排行',
      shortLabel: '昨日',
      filter: `ul.created_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz AND ul.created_at < CURRENT_DATE::timestamptz`,
      boundsSql: `SELECT (CURRENT_DATE - INTERVAL '1 day')::timestamptz AS start_time, CURRENT_DATE::timestamptz AS end_time`,
    }),
    week: Object.freeze({
      label: '本周排行',
      shortLabel: '本周',
      filter: `ul.created_at >= date_trunc('week', NOW()) AND ul.created_at <= NOW()`,
      boundsSql: `SELECT date_trunc('week', NOW()) AS start_time, NOW() AS end_time`,
    }),
    last_week: Object.freeze({
      label: '上周排行',
      shortLabel: '上周',
      filter: `ul.created_at >= date_trunc('week', NOW()) - INTERVAL '1 week' AND ul.created_at < date_trunc('week', NOW())`,
      boundsSql: `SELECT date_trunc('week', NOW()) - INTERVAL '1 week' AS start_time, date_trunc('week', NOW()) AS end_time`,
    }),
    month: Object.freeze({
      label: '本月排行',
      shortLabel: '本月',
      filter: `ul.created_at >= date_trunc('month', NOW()) AND ul.created_at <= NOW()`,
      boundsSql: `SELECT date_trunc('month', NOW()) AS start_time, NOW() AS end_time`,
    }),
    last_month: Object.freeze({
      label: '上月排行',
      shortLabel: '上月',
      filter: `ul.created_at >= date_trunc('month', NOW()) - INTERVAL '1 month' AND ul.created_at < date_trunc('month', NOW())`,
      boundsSql: `SELECT date_trunc('month', NOW()) - INTERVAL '1 month' AS start_time, date_trunc('month', NOW()) AS end_time`,
    }),
    total: Object.freeze({
      label: '总排行',
      shortLabel: '所有时间',
      filter: `TRUE`,
      boundsSql: `SELECT MIN(created_at) AS start_time, NOW() AS end_time FROM usage_logs`,
    }),
  });

  const PERSONAL_RANGES = Object.freeze(['today', 'yesterday', 'total']);
  const DEPARTMENT_RANGES = Object.freeze(['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);

  function pickRangeField(ranges, field) {
    return Object.freeze(Object.fromEntries((ranges || []).map(range => [range, RANGE_DEFINITIONS[range]?.[field] || ''])));
  }

  function rangeTabs(ranges = []) {
    return ranges.map(range => [range, RANGE_DEFINITIONS[range]?.label || range]);
  }

  function rangeLabel(range) {
    return RANGE_DEFINITIONS[range]?.label || '';
  }

  function rangeShortLabel(range) {
    return RANGE_DEFINITIONS[range]?.shortLabel || rangeLabel(range).replace('排行', '') || '今日';
  }

  const api = Object.freeze({
    RANGE_DEFINITIONS,
    PERSONAL_RANGES,
    DEPARTMENT_RANGES,
    pickRangeField,
    rangeTabs,
    rangeLabel,
    rangeShortLabel,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIUsageRanges = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
