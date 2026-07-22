'use strict';

const fs = require('fs');
const path = require('path');
const intentContract = require('../../client/core/intent-contract');
const routeService = require('../../client/services/route-service');

const SCHEMA_VERSION = 'intent-routing-eval.v1';
const VALID_OPERATIONS = new Set([
  'plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare',
  'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify',
]);
const VALID_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
const VALID_RESOURCE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context']);
const VALID_RESOURCE_MATCH_MODES = new Set(['exact', 'contains', 'media_exact']);
const SCORE_WEIGHTS = Object.freeze({
  valid_contract: 15,
  operation: 25,
  relation: 15,
  resources: 25,
  clarification: 10,
  directive: 10,
});

function fail(message) {
  throw new Error(`[intent-routing-eval] ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateResourceExpectation(resource = {}, label = 'resource') {
  if (!isPlainObject(resource)) fail(`${label} must be an object.`);
  if (!VALID_RESOURCE_TYPES.has(resource.type)) fail(`${label}.type is invalid.`);
  if (!VALID_RESOURCE_SOURCES.has(resource.source)) fail(`${label}.source is invalid.`);
  if (!VALID_RESOURCE_ROLES.has(resource.role)) fail(`${label}.role is invalid.`);
  if (!Number.isInteger(resource.index) || resource.index < 1) fail(`${label}.index must be a positive integer.`);
  if (typeof resource.missing !== 'boolean') fail(`${label}.missing must be boolean.`);
  for (const key of ['id', 'reference_id']) {
    if (key in resource && typeof resource[key] !== 'string') fail(`${label}.${key} must be a string when present.`);
  }
}

function validateExpected(expected = {}, label = 'expected') {
  if (!isPlainObject(expected)) fail(`${label} must be an object.`);
  if (!VALID_OPERATIONS.has(expected.operation)) fail(`${label}.operation is invalid.`);
  if (!VALID_RELATIONS.has(expected.relation)) fail(`${label}.relation is invalid.`);
  if (typeof expected.clarification !== 'boolean') fail(`${label}.clarification must be boolean.`);
  if (!isPlainObject(expected.directive) || !['standalone', 'patch'].includes(expected.directive.mode)) {
    fail(`${label}.directive.mode must be standalone or patch.`);
  }
  if ('unmentioned_policy' in expected.directive && !['preserve', 'allow_change'].includes(expected.directive.unmentioned_policy)) {
    fail(`${label}.directive.unmentioned_policy is invalid.`);
  }
  if (!isPlainObject(expected.resources) || !VALID_RESOURCE_MATCH_MODES.has(expected.resources.mode) || !Array.isArray(expected.resources.items)) {
    fail(`${label}.resources must contain a mode and items array.`);
  }
  if (expected.resources.mode === 'media_exact' && expected.resources.items.some(resource => !['image', 'file'].includes(resource.type))) {
    fail(`${label}.resources.media_exact may contain only image or file expectations.`);
  }
  expected.resources.items.forEach((resource, index) => validateResourceExpectation(resource, `${label}.resources.items[${index}]`));
}

function validateFixtureCase(caseDefinition = {}, seenIds = new Set()) {
  if (!isPlainObject(caseDefinition)) fail('Every fixture case must be an object.');
  const id = String(caseDefinition.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('Every fixture case needs a kebab-case id.');
  if (seenIds.has(id)) fail(`Duplicate fixture id: ${id}.`);
  seenIds.add(id);
  if (!String(caseDefinition.category || '').trim()) fail(`${id}.category is required.`);
  if (!String(caseDefinition.input || '').trim()) fail(`${id}.input is required.`);
  if (!Array.isArray(caseDefinition.attachments)) fail(`${id}.attachments must be an array.`);
  if (!isPlainObject(caseDefinition.context)) fail(`${id}.context must be an object.`);
  validateExpected(caseDefinition.expected, `${id}.expected`);

  for (const resource of caseDefinition.expected.resources.items) {
    if (resource.missing) continue;
    const candidate = intentContract.resolveResourceCandidate(resource, resource.type, {
      context: caseDefinition.context,
      attachments: caseDefinition.attachments,
      operation: caseDefinition.expected.operation,
    });
    if (!candidate) fail(`${id} has an expected resource that cannot resolve to exactly one fixture candidate.`);
  }
}

function validateFixtureSuite(suite = {}) {
  if (!isPlainObject(suite)) fail('Fixture suite must be an object.');
  if (suite.schema_version !== SCHEMA_VERSION) fail(`Fixture schema_version must be ${SCHEMA_VERSION}.`);
  if (!Array.isArray(suite.cases) || !suite.cases.length) fail('Fixture suite must contain at least one case.');
  const seenIds = new Set();
  suite.cases.forEach(caseDefinition => validateFixtureCase(caseDefinition, seenIds));
  return suite;
}

function loadFixtureSuite(filePath) {
  const resolvedPath = path.resolve(filePath);
  return { filePath: resolvedPath, suite: validateFixtureSuite(readJson(resolvedPath)) };
}

function taskContractFromRoute(route = null) {
  if (!route || typeof route !== 'object') return null;
  if (route.taskContract && typeof route.taskContract === 'object') return route.taskContract;
  return route.schema_version ? route : null;
}

function resourcesMatch(expected = {}, actual = {}) {
  for (const [field, value] of Object.entries(expected)) {
    if (field === 'index') {
      if (Number(actual[field]) !== Number(value)) return false;
      continue;
    }
    if (field === 'missing') {
      if (Boolean(actual[field]) !== value) return false;
      continue;
    }
    if (String(actual[field] || '') !== String(value || '')) return false;
  }
  return true;
}

function resourcesMatchExpectation(expectedResources = {}, actualResources = []) {
  const allActualResources = Array.isArray(actualResources) ? actualResources : [];
  const unmatched = expectedResources.mode === 'media_exact'
    ? allActualResources.filter(resource => ['image', 'file'].includes(resource?.type))
    : [...allActualResources];
  for (const expected of expectedResources.items || []) {
    const matchIndex = unmatched.findIndex(actual => resourcesMatch(expected, actual));
    if (matchIndex < 0) return false;
    unmatched.splice(matchIndex, 1);
  }
  return expectedResources.mode === 'contains' || unmatched.length === 0;
}

function directiveMatchesExpectation(expected = {}, actual = {}) {
  return Object.entries(expected).every(([field, value]) => String(actual?.[field] || '') === String(value || ''));
}

function clarificationMatchesExpectation(expected = false, task = {}) {
  const clarification = task?.clarification || {};
  const question = String(clarification.question || '').trim();
  const missingKeys = Array.isArray(clarification.missing_resource_keys) ? clarification.missing_resource_keys : [];
  if (expected) return task.operation === 'clarify' && !!question;
  return task.operation !== 'clarify' && !question && missingKeys.length === 0;
}

function scoreRouteCase(caseDefinition = {}, route = null) {
  const expected = caseDefinition.expected || {};
  const task = taskContractFromRoute(route);
  const validContract = !!task && typeof intentContract.hasExactContractShape === 'function' && intentContract.hasExactContractShape(task);
  const checks = {
    valid_contract: validContract,
    operation: validContract && task.operation === expected.operation,
    relation: validContract && task.relation === expected.relation,
    resources: validContract && resourcesMatchExpectation(expected.resources, task.resources),
    clarification: validContract && clarificationMatchesExpectation(expected.clarification, task),
    directive: validContract && directiveMatchesExpectation(expected.directive, task.directive),
  };
  const score = Object.entries(SCORE_WEIGHTS).reduce((total, [key, weight]) => total + (checks[key] ? weight : 0), 0);
  const failureReasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    id: String(caseDefinition.id || ''),
    category: String(caseDefinition.category || ''),
    score,
    checks,
    perfect: failureReasons.length === 0,
    failure_reasons: failureReasons,
  };
}

function evaluateRouteText(caseDefinition = {}, rawText = '') {
  const route = routeService.parseRouteResult(rawText, {
    input: caseDefinition.input,
    attachments: caseDefinition.attachments || [],
    context: caseDefinition.context || {},
  });
  return scoreRouteCase(caseDefinition, route);
}

function summarizeCaseScores(results = []) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const dimensionAccuracy = Object.fromEntries(Object.keys(SCORE_WEIGHTS).map(key => [key,
    total ? Number((list.filter(result => result?.checks?.[key]).length * 100 / total).toFixed(2)) : 0,
  ]));
  const byCategory = {};
  for (const result of list) {
    const category = String(result?.category || 'uncategorized');
    if (!byCategory[category]) byCategory[category] = { total: 0, perfect_cases: 0, score_total: 0 };
    byCategory[category].total += 1;
    byCategory[category].score_total += Number(result?.score) || 0;
    if (result?.perfect) byCategory[category].perfect_cases += 1;
  }
  for (const summary of Object.values(byCategory)) {
    summary.average_score = Number((summary.score_total / summary.total).toFixed(2));
    summary.perfect_case_rate = Number((summary.perfect_cases * 100 / summary.total).toFixed(2));
    delete summary.score_total;
  }
  return {
    total_cases: total,
    average_score: total ? Number((list.reduce((sum, result) => sum + (Number(result?.score) || 0), 0) / total).toFixed(2)) : 0,
    perfect_cases: list.filter(result => result?.perfect).length,
    perfect_case_rate: total ? Number((list.filter(result => result?.perfect).length * 100 / total).toFixed(2)) : 0,
    dimension_accuracy: dimensionAccuracy,
    by_category: byCategory,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SCORE_WEIGHTS,
  validateFixtureSuite,
  loadFixtureSuite,
  resourcesMatchExpectation,
  scoreRouteCase,
  evaluateRouteText,
  summarizeCaseScores,
};
