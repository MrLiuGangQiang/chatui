'use strict';

const SCHEMA_VERSION = 'chatui_plugins.v1';
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_TOOLS_PER_PLUGIN = 32;
const MAX_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function error(message, code = 'PLUGIN_CONFIG_INVALID', statusCode = 400) {
  const item = new Error(message);
  item.code = code;
  item.statusCode = statusCode;
  return item;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRisk(value, fallback = 'read') {
  const risk = String(value || fallback).trim().toLowerCase();
  return ['read', 'write', 'destructive'].includes(risk) ? risk : '';
}

function normalizeJsonSchema(value) {
  if (!isPlainObject(value)) return null;
  const type = String(value.type || 'object').trim();
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) return null;
  const schema = { type };
  if (Array.isArray(value.required)) {
    const required = [...new Set(value.required.map(item => String(item || '').trim()))].filter(Boolean);
    if (required.some(item => item.length > MAX_TOOL_NAME_LENGTH)) return null;
    if (required.length) schema.required = required;
  }
  if (Array.isArray(value.enum) && value.enum.length <= 100) schema.enum = value.enum.map(item => item);
  if (Object.prototype.hasOwnProperty.call(value, 'additionalProperties')) {
    schema.additionalProperties = value.additionalProperties === true;
  } else {
    schema.additionalProperties = false;
  }
  if (value.description && typeof value.description === 'string') schema.description = value.description.slice(0, 1000);
  if (type === 'object') {
    if (!isPlainObject(value.properties)) return null;
    const entries = Object.entries(value.properties).slice(0, 32);
    if (Object.keys(value.properties).length > 32) return null;
    const properties = {};
    for (const [key, item] of entries) {
      const child = normalizeJsonSchema(item);
      if (!child || !TOOL_NAME_PATTERN.test(key)) return null;
      properties[key] = child;
    }
    schema.properties = properties;
  }
  if (type === 'array') {
    const items = normalizeJsonSchema(value.items);
    if (!items) return null;
    schema.items = items;
    if (Number.isFinite(value.maxItems) && value.maxItems >= 0) schema.maxItems = Math.floor(value.maxItems);
  }
  if (Number.isFinite(value.minLength) && value.minLength >= 0) schema.minLength = Math.floor(value.minLength);
  if (Number.isFinite(value.maxLength) && value.maxLength >= 0) schema.maxLength = Math.floor(value.maxLength);
  if (Number.isFinite(value.minimum) && value.minimum >= Number.MIN_SAFE_INTEGER) schema.minimum = value.minimum;
  if (Number.isFinite(value.maximum) && value.maximum <= Number.MAX_SAFE_INTEGER) schema.maximum = value.maximum;
  return schema;
}

function validateValue(value, schema, path = 'arguments') {
  if (!isPlainObject(schema)) return 'invalid schema';
  const type = schema.type || 'object';
  const actual = type === 'integer' && Number.isInteger(value) ? 'integer'
    : type === 'number' && typeof value === 'number' && Number.isFinite(value) ? 'number'
      : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (actual !== type) return `${path} must be ${type}`;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path} is not in the allowed values`;
  }
  if (type === 'object') {
    const keys = Object.keys(value);
    const allowed = Object.keys(schema.properties || {});
    if (schema.additionalProperties === false && keys.some(key => !allowed.includes(key))) {
      return `${path} contains unsupported fields`;
    }
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const failure = validateValue(value[key], child, `${path}.${key}`);
        if (failure) return failure;
      }
    }
  }
  if (type === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items`;
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateValue(value[index], schema.items, `${path}[${index}]`);
      if (failure) return failure;
    }
  }
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
  }
  if ((type === 'number' || type === 'integer')) {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above the maximum`;
  }
  return '';
}

function validateArguments(value, schema) {
  if (!isPlainObject(value)) return 'tool arguments must be a JSON object';
  return validateValue(value, normalizeJsonSchema(schema) || { type: 'object', properties: { _invalid: { type: 'string' } }, additionalProperties: false });
}

function normalizeAuth(value = {}) {
  if (!isPlainObject(value)) return null;
  const type = String(value.type || 'none').trim().toLowerCase();
  if (!['none', 'bearer'].includes(type)) return null;
  if (type === 'none') return { type };
  const envName = String(value.env || '').trim();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(envName)) return null;
  return { type, env: envName };
}

function normalizeHttpTool(value = {}) {
  if (!isPlainObject(value)) return null;
  const name = String(value.name || '').trim();
  if (!TOOL_NAME_PATTERN.test(name)) return null;
  const method = String(value.method || 'GET').trim().toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const path = String(value.path || '').trim();
  if (!path.startsWith('/') || path.includes('..') || path.includes('\\') || /[^\/{}A-Za-z0-9._~:-]/.test(path)) return null;
  const inputSchema = normalizeJsonSchema(value.inputSchema || value.input_schema);
  if (!inputSchema) return null;
  const risk = normalizeRisk(value.risk, method === 'GET' ? 'read' : 'write');
  if (!risk) return null;
  return {
    name,
    description: String(value.description || `HTTP ${method} ${path}`).slice(0, 1000),
    method,
    path,
    inputSchema,
    risk,
    requiresApproval: value.requiresApproval === true || (value.requiresApproval === undefined && risk !== 'read'),
  };
}

function normalizeMcpAllowedTool(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').trim();
  if (!TOOL_NAME_PATTERN.test(name)) return null;
  return {
    name,
    description: String(value.description || '').slice(0, 1000),
    risk: normalizeRisk(value.risk, 'read') || 'read',
    requiresApproval: value.requiresApproval === true || (value.requiresApproval === undefined && String(value.risk || 'read') !== 'read'),
  };
}

function normalizePlugin(value = {}) {
  if (!isPlainObject(value)) return null;
  const id = String(value.id || '').trim();
  if (!PLUGIN_ID_PATTERN.test(id)) return null;
  const type = String(value.type || '').trim().toLowerCase();
  if (!['http', 'mcp'].includes(type)) return null;
  const label = String(value.label || id).slice(0, 80);
  const enabled = value.enabled !== false;
  const auth = normalizeAuth(value.auth);
  if (!auth) return null;
  if (type === 'http') {
    const baseUrl = String(value.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) return null;
    const tools = Array.isArray(value.tools) ? value.tools : [];
    if (!tools.length || tools.length > MAX_TOOLS_PER_PLUGIN) return null;
    const normalizedTools = tools.map(normalizeHttpTool);
    if (normalizedTools.some(tool => !tool)) return null;
    const names = new Set(normalizedTools.map(tool => tool.name));
    if (names.size !== normalizedTools.length) return null;
    return { id, type, label, enabled, baseUrl, auth, tools: normalizedTools };
  }
  const serverUrl = String(value.serverUrl || value.server_url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(serverUrl)) return null;
  const configured = Array.isArray(value.tools) ? value.tools : [];
  if (!configured.length || configured.length > MAX_TOOLS_PER_PLUGIN) return null;
  const tools = configured.map(normalizeMcpAllowedTool);
  if (tools.some(tool => !tool)) return null;
  const names = new Set(tools.map(tool => tool.name));
  if (names.size !== tools.length) return null;
  return { id, type, label, enabled, serverUrl, auth, tools };
}

function normalizePluginConfig(value = {}) {
  if (!isPlainObject(value) || value.schema_version !== SCHEMA_VERSION) return null;
  const plugins = Array.isArray(value.plugins) ? value.plugins : [];
  if (plugins.length > 16) return null;
  const normalized = plugins.map(normalizePlugin);
  if (normalized.some(plugin => !plugin)) return null;
  const ids = new Set(normalized.map(plugin => plugin.id));
  if (ids.size !== normalized.length) return null;
  const toolNames = normalized.flatMap(plugin => plugin.tools.map(tool => tool.name));
  if (new Set(toolNames).size !== toolNames.length) return null;
  return { schemaVersion: SCHEMA_VERSION, plugins: normalized };
}

function publicPlugin(plugin = {}) {
  const tools = (Array.isArray(plugin.tools) ? plugin.tools : []).map(tool => ({
    name: tool.name,
    description: tool.description || '',
    risk: tool.risk || 'read',
    requiresApproval: tool.requiresApproval !== false,
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
  }));
  return {
    id: plugin.id,
    type: plugin.type,
    label: plugin.label,
    enabled: plugin.enabled !== false,
    tools,
  };
}

function chatCompletionsTool(tool = {}) {
  return {
    type: 'function',
    function: {
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      parameters: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_CONFIG_BYTES,
  normalizePluginConfig,
  publicPlugin,
  chatCompletionsTool,
  validateArguments,
  normalizeJsonSchema,
  error,
};
