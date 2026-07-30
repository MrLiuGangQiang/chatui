'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function applyMissingEnvironment(source = '', env = process.env) {
  const parsed = parseEnv(String(source || ''));
  const applied = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!ENV_NAME_PATTERN.test(name) || env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

function loadLocalEnv({ root = path.resolve(__dirname, '../..'), env = process.env } = {}) {
  const file = path.join(root, '.env.local');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ loaded: false, applied: Object.freeze([]) });
    throw error;
  }
  const applied = applyMissingEnvironment(source, env);
  return Object.freeze({ loaded: true, applied: Object.freeze(applied) });
}

module.exports = { applyMissingEnvironment, loadLocalEnv };
