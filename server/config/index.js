const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '../..');
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/responses\/?$/, /^\/images\/generations\/?$/, /^\/openai\/image_edit\/?$/];
const { DEFAULT_CONTEXT_WINDOW_TOKENS, normalizeContextWindowTokens } = require('../../client/core/context-budget');
const CONTEXT_WINDOW_TOKENS = normalizeContextWindowTokens(process.env.CHATUI_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);
const pkg = require('../../package.json');
const APP_VERSION = String(pkg.version || '0.0.0');

function readPublicConfig() {
  const file = path.join(ROOT, 'config', 'public.json');
  const fallback = { ui: {}, features: {} };
  const withContext = config => ({ ...config, context: { ...(config.context || {}), windowTokens: CONTEXT_WINDOW_TOKENS } });
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return withContext(fallback);
    return withContext({
      ui: parsed.ui && typeof parsed.ui === 'object' && !Array.isArray(parsed.ui) ? parsed.ui : {},
      features: parsed.features && typeof parsed.features === 'object' && !Array.isArray(parsed.features) ? parsed.features : {},
      context: parsed.context && typeof parsed.context === 'object' && !Array.isArray(parsed.context) ? parsed.context : {},
    });
  } catch {
    return withContext(fallback);
  }
}

module.exports = {
  PORT,
  HOST,
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
