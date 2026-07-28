(function initChatUIUsageRanges(root) {
  'use strict';

  const RANGE_DEFINITIONS = Object.freeze({
    today: Object.freeze({
      label: '今日排行',
      shortLabel: '今日',
    }),
    yesterday: Object.freeze({
      label: '昨日排行',
      shortLabel: '昨日',
    }),
    week: Object.freeze({
      label: '本周排行',
      shortLabel: '本周',
    }),
    last_week: Object.freeze({
      label: '上周排行',
      shortLabel: '上周',
    }),
    month: Object.freeze({
      label: '本月排行',
      shortLabel: '本月',
    }),
    last_month: Object.freeze({
      label: '上月排行',
      shortLabel: '上月',
    }),
    total: Object.freeze({
      label: '总排行',
      shortLabel: '所有时间',
    }),
  });

  const PERSONAL_RANGES = Object.freeze(['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);
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
  else if (root) root.ChatUIUsageRanges = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
