'use strict';

const fs = require('fs');
const {
  DEFAULT_MODEL_RECOMMENDATION,
  MAX_MODEL_RECOMMENDATION_BYTES,
  normalizeModelRecommendation,
} = require('../../shared/model-recommendation');

function readModelRecommendation({ filePath, fsImpl = fs } = {}) {
  if (!filePath) return DEFAULT_MODEL_RECOMMENDATION;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_MODEL_RECOMMENDATION_BYTES) return DEFAULT_MODEL_RECOMMENDATION;
    return normalizeModelRecommendation(JSON.parse(fsImpl.readFileSync(filePath, 'utf8')));
  } catch {
    return DEFAULT_MODEL_RECOMMENDATION;
  }
}

module.exports = {
  readModelRecommendation,
};
