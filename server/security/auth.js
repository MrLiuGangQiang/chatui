const crypto = require('crypto');

const DEPLOYMENT_MODES = Object.freeze(['local', 'managed']);
const PUBLIC_API_PATHS = new Set(['/api/version', '/api/config/public']);
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function parseDeploymentMode(raw, errors = []) {
  const mode = String(raw || 'local').trim().toLowerCase() || 'local';
  if (!DEPLOYMENT_MODES.includes(mode)) {
    errors.push('CHATUI_DEPLOYMENT_MODE must be either local or managed.');
    return 'local';
  }
  return mode;
}

function parseStaticAuthTokens(raw, errors = []) {
  const source = String(raw || '').trim();
  if (!source) return Object.freeze([]);

  const seenIds = new Set();
  const seenHashes = new Set();
  const tokens = [];
  for (const entry of source.split(',')) {
    const item = String(entry || '').trim();
    const delimiter = item.indexOf(':');
    if (delimiter < 1 || delimiter === item.length - 1) {
      errors.push('CHATUI_AUTH_TOKENS entries must use principal:token format.');
      continue;
    }
    const id = item.slice(0, delimiter).trim();
    const token = item.slice(delimiter + 1).trim();
    if (!PRINCIPAL_ID_PATTERN.test(id)) {
      errors.push('CHATUI_AUTH_TOKENS principals must use 1-128 letters, numbers, dots, underscores, or hyphens and start with a letter or number.');
      continue;
    }
    if (!token || /\s/.test(token)) {
      errors.push('CHATUI_AUTH_TOKENS tokens must not be empty or contain whitespace.');
      continue;
    }
    const tokenHash = sha256(token);
    const hashKey = tokenHash.toString('hex');
    if (seenIds.has(id)) {
      errors.push(`CHATUI_AUTH_TOKENS contains the duplicate principal ${id}.`);
      continue;
    }
    if (seenHashes.has(hashKey)) {
      errors.push('CHATUI_AUTH_TOKENS must not assign one token to multiple principals.');
      continue;
    }
    seenIds.add(id);
    seenHashes.add(hashKey);
    tokens.push(Object.freeze({ id, tokenHash }));
  }
  return Object.freeze(tokens);
}

function requestPath(req) {
  return String(req?.url || '').split('?')[0];
}

function shouldAuthenticateApiRequest(req) {
  const path = requestPath(req);
  return path.startsWith('/api/') && !PUBLIC_API_PATHS.has(path);
}

function parseBearerToken(header) {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value || '').trim());
  return match ? match[1] : '';
}

function hashesMatch(left, right) {
  return Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function createAuthPolicy({ deploymentMode = 'local', authTokens = [] } = {}) {
  const enabled = deploymentMode === 'managed';
  const tokens = Object.freeze(Array.from(authTokens || []).map(entry => Object.freeze({
    id: String(entry.id || ''),
    tokenHash: Buffer.from(entry.tokenHash || []),
  })));
  if (enabled && !tokens.length) throw new TypeError('Managed authentication requires at least one configured token.');

  return Object.freeze({
    enabled,
    deploymentMode: enabled ? 'managed' : 'local',
    shouldAuthenticate: shouldAuthenticateApiRequest,
    authenticate(req) {
      req.authRequired = enabled && shouldAuthenticateApiRequest(req);
      if (!req.authRequired) return { authenticated: true, principal: null };
      const token = parseBearerToken(req?.headers?.authorization);
      if (!token) return { authenticated: false, principal: null };
      const suppliedHash = sha256(token);
      let principal = null;
      for (const candidate of tokens) {
        if (hashesMatch(candidate.tokenHash, suppliedHash) && !principal) {
          principal = Object.freeze({ id: candidate.id, type: 'static-bearer' });
        }
      }
      if (!principal) return { authenticated: false, principal: null };
      req.principal = principal;
      return { authenticated: true, principal };
    },
  });
}

function authenticationError() {
  return Object.freeze({
    statusCode: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication required',
  });
}

module.exports = {
  DEPLOYMENT_MODES,
  PUBLIC_API_PATHS,
  parseDeploymentMode,
  parseStaticAuthTokens,
  parseBearerToken,
  createAuthPolicy,
  authenticationError,
  shouldAuthenticateApiRequest,
};
