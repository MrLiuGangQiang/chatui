const path = require('path');
const { createPublicConfigReader } = require('./public-config');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_UPSTREAM_BASE_URL = String(process.env.DEFAULT_UPSTREAM_BASE_URL || 'https://ingress.lfans.cn/v1').trim().replace(/\/+$/, '');
const ROOT = path.resolve(__dirname, '../..');
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/responses\/?$/, /^\/images\/generations\/?$/, /^\/images\/edits\/?$/, /^\/openai\/image_edit\/?$/];
const { DEFAULT_CONTEXT_WINDOW_TOKENS, normalizeContextWindowTokens } = require('../../shared/config/context-budget');
const CONTEXT_WINDOW_TOKENS = normalizeContextWindowTokens(process.env.CHATUI_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);
const pkg = require('../../package.json');
const APP_VERSION = String(pkg.version || '0.0.0');
const readPublicConfig = createPublicConfigReader({ root: ROOT, contextWindowTokens: CONTEXT_WINDOW_TOKENS });

module.exports = {
  PORT,
  HOST,
  DEFAULT_UPSTREAM_BASE_URL,
  ROOT,
  ROOT_WITH_SEP,
  UPSTREAM_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  ALLOWED_PROXY_METHODS,
  ALLOWED_PROXY_PATHS,
  APP_VERSION,
  readPublicConfig,
};
