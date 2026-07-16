const path = require('path');
const { createPublicConfigReader } = require('./public-config');
const { assertRuntimeConfig } = require('./runtime-config');

const runtimeConfig = assertRuntimeConfig();
const PORT = runtimeConfig.port;
const HOST = runtimeConfig.host;
const DEFAULT_UPSTREAM_BASE_URL = runtimeConfig.defaultUpstreamBaseUrl;
const ROOT = path.resolve(__dirname, '../..');
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const UPSTREAM_TIMEOUT_MS = runtimeConfig.upstreamTimeoutMs;
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/responses\/?$/, /^\/images\/generations\/?$/, /^\/images\/edits\/?$/, /^\/openai\/image_edit\/?$/];
const { DEFAULT_CONTEXT_WINDOW_TOKENS } = require('../../shared/config/context-budget');
const CONTEXT_WINDOW_TOKENS = runtimeConfig.contextWindowTokens;
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
  runtimeConfig,
  readPublicConfig,
};
