const sharedRanges = require('../../shared/usage/ranges');

const {
  RANGE_DEFINITIONS,
  PERSONAL_RANGES,
  DEPARTMENT_RANGES,
  rangeLabel,
  rangeShortLabel,
  rangeTabs,
} = sharedRanges;

const RANGE_FILTERS = sharedRanges.pickRangeField(PERSONAL_RANGES, 'filter');
const DEPARTMENT_RANGE_FILTERS = sharedRanges.pickRangeField(DEPARTMENT_RANGES, 'filter');
const DEPARTMENT_RANGE_BOUNDS_SQL = sharedRanges.pickRangeField(DEPARTMENT_RANGES, 'boundsSql');
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
  isPersonalRange,
  isDepartmentRange,
  rangeLabel,
  rangeShortLabel,
  rangeTabs,
};
