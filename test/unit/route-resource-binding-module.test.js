'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const resourceIdentity = require('../../client/core/resource-identity');
const bindingModule = require('../../client/services/route-resource-binding');
const routeService = require('../../client/services/route-service');

function createBinding(catalog = []) {
  return bindingModule.createRouteResourceBinding({
    resourceIdentityModule: resourceIdentity,
    normalizedSource: (value, fallback = 'context') => {
      const source = String(value || '').trim();
      if (['current', 'quoted', 'history', 'context'].includes(source)) return source;
      return fallback;
    },
    uniqueStrings: values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))],
    uniqueIndexes: values => [...new Set((values || []).map(Number).filter(value => Number.isInteger(value) && value >= 1))],
    routeCompilationCandidateCatalog: () => catalog,
  });
}

function testResourceBindingCanonicalizesRolesByOperationAndType() {
  const binding = createBinding();
  assert.strictEqual(binding.canonicalBindingRole('image_reference_gen', 'image', 'target'), 'reference');
  assert.strictEqual(binding.canonicalBindingRole('edit_image', 'image', 'mask_image'), 'mask');
  assert.strictEqual(binding.canonicalBindingRole('plain_chat', 'file', 'source'), 'attachment');
  assert.strictEqual(binding.canonicalBindingRole('plain_chat', 'message', 'source'), 'context');
  assert.deepStrictEqual(binding.canonicalPlanBindings({
    operation: 'edit_image',
    bindings: [{ key: 'r1', type: 'image', role: 'source' }],
  }), [{ key: 'r1', type: 'image', role: 'target' }]);
}

function testResourceBindingNormalizesClarificationSlotsWithoutKeyCollisions() {
  const binding = createBinding();
  const issues = binding.normalizeResourceClarificationIssues([
    binding.unresolvedResourceIssue({
      key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
      candidates: [
        { candidate_key: 'i1', source: 'history', index: 1, id: 'a', resource_id: 'res:image:a', label: 'A' },
        { candidate_key: 'i2', source: 'history', index: 2, id: 'b', resource_id: 'res:image:b', label: 'B' },
      ],
    }),
    binding.unresolvedResourceIssue({ type: 'file', role: 'attachment', reason: 'missing' }),
  ], [{ key: 'r1' }]);
  assert.deepStrictEqual(issues.map(issue => [issue.key, issue.type, issue.reason]), [
    ['r2', 'image', 'ambiguous'],
    ['r3', 'file', 'missing'],
  ]);
  assert.deepStrictEqual(issues[0].choices.map(choice => [choice.key, choice.resource_id]), [
    ['c1', 'res:image:a'],
    ['c2', 'res:image:b'],
  ]);
}

function testResourceBindingResolvesCandidateKeysAndUnavailableResources() {
  const catalog = [
    {
      candidate_key: 'i1', type: 'image', source: 'current', index: 1, id: 'image-1',
      resource_id: 'res:image:image-1', reference_id: 'ref-1', identity_aliases: ['image-1'], index_aliases: [1], availability: 'available',
    },
    {
      candidate_key: 'f1', type: 'file', source: 'current', index: 1, id: 'file-1',
      resource_id: 'res:file:file-1', reference_id: '', identity_aliases: ['file-1'], index_aliases: [1], availability: 'unavailable',
    },
  ];
  const binding = createBinding(catalog);
  const resolved = binding.resolvePlanResources({
    operation: 'multimodal_qa',
    bindings: [
      { key: 'r1', type: 'image', role: 'source', resource_id: 'i1', source: 'current' },
      { key: 'r2', type: 'file', role: 'attachment', resource_id: 'f1', source: 'current' },
    ],
  });
  assert.strictEqual(resolved.projected.length, 1);
  assert.strictEqual(resolved.projected[0].resource_id, 'res:image:image-1');
  assert.deepStrictEqual(resolved.issues, [{
    key: 'r2', type: 'file', role: 'attachment', reason: 'unavailable', choices: [],
  }]);
}

function testRouteServiceUsesResourceBindingModuleWithoutReembeddingImplementation() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const bindingSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-resource-binding.js'), 'utf8');
  assert.doesNotMatch(routeSource, /function canonicalBindingRole\s*\(/);
  assert.doesNotMatch(routeSource, /function normalizeResourceClarificationIssues\s*\(/);
  assert.doesNotMatch(routeSource, /function resolvePlanResources\s*\(/);
  assert.match(routeSource, /createRouteResourceBinding/);
  assert.match(bindingSource, /function canonicalBindingRole\s*\(/);
  assert.match(bindingSource, /function normalizeResourceClarificationIssues\s*\(/);
  assert.match(bindingSource, /function resolvePlanResources\s*\(/);
  assert.doesNotMatch(bindingSource, /root\.ChatUIRouteResourceBinding\s*=/,
    'the binding module must use the registry rather than add a browser global');
  assert.strictEqual(typeof routeService.compileLocalRoute, 'function');
}

module.exports = [
  testResourceBindingCanonicalizesRolesByOperationAndType,
  testResourceBindingNormalizesClarificationSlotsWithoutKeyCollisions,
  testResourceBindingResolvesCandidateKeysAndUnavailableResources,
  testRouteServiceUsesResourceBindingModuleWithoutReembeddingImplementation,
];