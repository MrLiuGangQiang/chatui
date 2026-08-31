const path = require('path');
const { createPublicConfigReader } = require('./public-config');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_UPSTREAM_BASE_URL = String(process.env.DEFAULT_UPSTREAM_BASE_URL || 'https://ingress.lfans.cn/v1').trim().replace(/\/+$/, '');
// Shared presence store for multi-instance deployments. Keep this server-side:
// the URL may contain credentials and must never be exposed through
// /api/config/public or any static asset.
const REDIS_URL = String(process.env.REDIS_URL || '').trim() || null;
const ROOT = path.resolve(__dirname, '../..');
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/responses\/?$/, /^\/images\/generations\/?$/, /^\/images\/edits\/?$/, /^\/openai\/image_edit\/?$/];
const { DEFAULT_CONTEXT_WINDOW_TOKENS, normalizeContextWindowTokens } = require('../../shared/config/context-budget');
const CONTEXT_WINDOW_TOKENS = normalizeContextWindowTokens(process.env.CHATUI_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);
const CONTEXT_SUMMARIZE_OMITTED = String(process.env.CHATUI_CONTEXT_SUMMARIZE_OMITTED || '').trim() === '1';
const { readVersion } = require('../version-source');
const APP_VERSION = readVersion({ root: ROOT });
const { createBuildIdentity } = require('../build-identity');
const BUILD_IDENTITY = createBuildIdentity({ root: ROOT, version: APP_VERSION });

const DEFAULT_INTENT_PIPELINE_DEADLINE_MS = 300000;
function normalizeIntentDeadline(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
const INTENT_PIPELINE_DEADLINE_MS = normalizeIntentDeadline(process.env.CHATUI_INTENT_PIPELINE_DEADLINE_MS, DEFAULT_INTENT_PIPELINE_DEADLINE_MS);
const readPublicConfig = createPublicConfigReader({ root: ROOT, contextWindowTokens: CONTEXT_WINDOW_TOKENS, contextSummarizeOmitted: CONTEXT_SUMMARIZE_OMITTED, intentPipelineDeadlineMs: INTENT_PIPELINE_DEADLINE_MS });

// Optional provider capability descriptor (design doc v2.7 7.1). Absent or
// invalid JSON means "unconfigured" -> server gates treat the provider as
// unrestricted, preserving baseline behavior for existing deployments.
const PROVIDER_CAPABILITIES = (() => {
  const raw = String(process.env.CHATUI_PROVIDER_CAPABILITIES || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
})();

module.exports = {
  PORT,
  HOST,
  DEFAULT_UPSTREAM_BASE_URL,
  REDIS_URL,
  ROOT,
  ROOT_WITH_SEP,
  UPSTREAM_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  INTENT_PIPELINE_DEADLINE_MS,
  PROVIDER_CAPABILITIES,
  ALLOWED_PROXY_METHODS,
  ALLOWED_PROXY_PATHS,
  APP_VERSION,
  BUILD_IDENTITY,
  readPublicConfig,
};