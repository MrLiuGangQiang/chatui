'use strict';

// Design doc v2.7 section 7.1: provider capability negotiation happens before
// the server creates a Job. The capability registry is the intent-layer fact
// source; the provider is the execution-layer fact source. When the provider
// cannot serve the planned operation/roles/arguments and the registry declares
// an equivalent_alternative, this validator reports the alternative (the
// confirmation-style replacement must re-run the Intent Gate, never a local
// field swap). Without an alternative, it fails closed as unsupported.

const capabilityRegistry = require('../../shared/capability-registry');

function providerCapabilityError(message, code = 'PROVIDER_CAPABILITY_UNSUPPORTED', statusCode = 400) {
  const error = new TypeError(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function stringValue(value = '') {
  return String(value ?? '').trim();
}

function normalizedOperation(value = '') {
  return stringValue(value);
}

function operationCapabilities(provider = {}, operation = '') {
  const normalized = normalizedOperation(operation);
  const operations = provider?.operations || provider?.capabilities || {};
  return operations[normalized] || null;
}

// Provider capability descriptor shape (all optional; absence means "no
// restriction", preserving current behavior for unconfigured deployments):
// {
//   operations: {
//     edit_image: {
//       supported: true|false,
//       roles: { mask: false, target: true },        // role -> supported
//       arguments: { mask: { supported: false } },    // argument name -> spec
//     }
//   }
// }
function normalizeProviderCapabilities(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function providerSupportsOperation(provider = {}, operation = '') {
  const spec = operationCapabilities(provider, operation);
  if (!spec) return true; // unconfigured provider capability -> allow
  return spec.supported !== false;
}

function providerRoleIssues(provider = {}, operation = '', bindings = []) {
  const spec = operationCapabilities(provider, operation);
  if (!spec?.roles) return [];
  const issues = [];
  // Doc 7.1: the provider reports the same stable condition token the
  // registry declares (e.g. 'provider_unsupported_mask') so the two fact
  // sources can never invent replacements. Fall back to the generic role
  // code when no condition token is declared for that role.
  const conditionByRole = new Map();
  const alternatives = capabilityRegistry.equivalentAlternativesFor
    ? capabilityRegistry.equivalentAlternativesFor(operation)
    : [];
  for (const alternative of alternatives) {
    const condition = stringValue(alternative?.condition);
    const match = /^provider_unsupported_(.+)$/.exec(condition || '');
    if (match) conditionByRole.set(match[1], condition);
  }
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const role = stringValue(binding?.role);
    if (!role) continue;
    if (spec.roles[role] === false) {
      issues.push(Object.freeze({
        code: conditionByRole.get(role) || 'provider_role_unsupported',
        operation,
        role,
      }));
    }
  }
  return issues;
}

function providerArgumentIssues(provider = {}, operation = '', argumentsValue = {}) {
  const spec = operationCapabilities(provider, operation);
  if (!spec?.arguments) return [];
  const issues = [];
  for (const [name, value] of Object.entries(argumentsValue || {})) {
    const argumentSpec = spec.arguments[name];
    if (!argumentSpec) continue;
    if (argumentSpec.supported === false) {
      issues.push(Object.freeze({ code: 'provider_argument_unsupported', operation, argument: name, value }));
      continue;
    }
    if (Array.isArray(argumentSpec.values) && argumentSpec.values.length
        && !argumentSpec.values.some(allowed => String(allowed) === String(value))) {
      issues.push(Object.freeze({ code: 'provider_argument_value_unsupported', operation, argument: name, value }));
    }
  }
  return issues;
}

// Matches provider issues against the registry's equivalent_alternatives
// conditions. The condition is a stable token declared in the registry (e.g.
// 'provider_unsupported_mask'); the provider layer reports the same token as
// the issue code so the two fact sources can never invent replacements.
function equivalentAlternativeFor(operation = '', issues = []) {
  const alternatives = capabilityRegistry.equivalentAlternativesFor
    ? capabilityRegistry.equivalentAlternativesFor(operation)
    : [];
  const issueCodes = new Set(issues.map(issue => String(issue?.code || '')));
  for (const alternative of alternatives) {
    const condition = stringValue(alternative?.condition);
    if (!condition) continue;
    if (issueCodes.has(condition)) {
      return Object.freeze({
        operation: stringValue(alternative?.operation),
        condition,
        original_operation: normalizedOperation(operation),
      });
    }
  }
  return null;
}

// Validates the provider against the planned operation. Returns
// { supported: true } or { supported: false, issues, alternative }.
// `provider` may be null/{} meaning "unconfigured" -> supported (baseline).
function validateProviderCapability({ operation = '', bindings = [], argumentsValue = {}, provider = null } = {}) {
  const normalized = normalizedOperation(operation);
  if (!capabilityRegistry.capabilityFor?.(normalized)) {
    throw providerCapabilityError(
      `Unsupported execution operation: ${normalized || '<missing>'}`,
      'PROVIDER_CAPABILITY_OPERATION_UNKNOWN',
    );
  }
  const issues = [];
  if (!providerSupportsOperation(provider, normalized)) {
    issues.push(Object.freeze({ code: 'provider_operation_unsupported', operation: normalized }));
  }
  issues.push(...providerRoleIssues(provider, normalized, bindings));
  issues.push(...providerArgumentIssues(provider, normalized, argumentsValue));
  if (!issues.length) return Object.freeze({ supported: true, issues: Object.freeze([]), alternative: null });

  const alternative = equivalentAlternativeFor(normalized, issues);
  return Object.freeze({
    supported: false,
    issues: Object.freeze(issues),
    alternative,
  });
}

// Throwing wrapper for the Job-creation gate. Without an equivalent
// alternative, fail closed: never degrade to plain_chat, never swap the
// operation locally (doc 7.1 rule 7).
function assertProviderCapability({ operation = '', bindings = [], argumentsValue = {}, provider = null, allowAlternative = false } = {}) {
  const result = validateProviderCapability({ operation, bindings, argumentsValue, provider });
  if (result.supported) return result;
  if (result.alternative && allowAlternative) return result;
  const detail = result.issues.map(issue => `${issue.code}${issue.role ? `:${issue.role}` : ''}`).join(', ');
  const error = providerCapabilityError(
    `当前服务商不支持该执行方式（${detail}）`,
    'PROVIDER_CAPABILITY_UNSUPPORTED',
    400,
  );
  error.providerIssues = result.issues;
  error.alternative = result.alternative;
  throw error;
}

module.exports = {
  providerCapabilityError,
  normalizeProviderCapabilities,
  providerSupportsOperation,
  providerRoleIssues,
  providerArgumentIssues,
  equivalentAlternativeFor,
  validateProviderCapability,
  assertProviderCapability,
};
