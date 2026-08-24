'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeCandidates = require('../../client/services/route-candidates');
const resourceIdentity = require('../../client/core/resource-identity');
const attachments = require('../../client/core/attachments');
const routeService = require('../../client/services/route-service');

function createDirectory({ memorySelection = { cards: [], metadata: null }, metadataSymbol = Symbol('catalog') } = {}) {
  return {
    metadataSymbol,
    directory: routeCandidates.createCanonicalCandidateDirectory({
      resourceIdentityModule: resourceIdentity,
      attachmentsModule: attachments,
      validResourceSources: ['current', 'quoted', 'history', 'context'],
      selectImageMemoryCards: () => memorySelection,
      resourceCatalogMetadata: metadataSymbol,
    }),
  };
}

function testCanonicalCandidateDirectoryAssignsKeysRolesAndAvailability() {
  const { directory } = createDirectory();
  const catalog = directory.buildResourceCandidates([
    { is_image: true, type: 'image/png', image_id: 'upload-1', name: 'product.png', route_source: 'current' },
    { type: 'text/plain', file_id: 'file-1', name: 'notes.txt', route_source: 'current', has_extracted_text: false },
  ], {
    recent_messages: [{ index: 1, id: 'message-1', role: 'user', content: '请分析附件' }],
    quoted_message: { index: 1, id: 'message-1', role: 'user', content: '请分析附件' },
  });
  assert.deepStrictEqual(catalog.map(item => [item.candidate_key, item.type, item.source]), [
    ['i1', 'image', 'current'],
    ['f1', 'file', 'current'],
    ['m1', 'message', 'quoted'],
  ]);
  assert.strictEqual(catalog[0].resource_id, 'res:image:upload-1');
  assert.strictEqual(catalog[1].availability, 'unavailable');
  assert.strictEqual(catalog[1].unavailable_reason, 'file_text_unavailable');
  assert.strictEqual(catalog[2].resource_id, 'res:message:message-1');
}

function testCanonicalCandidateDirectoryDeduplicatesIdentityAliasesWithoutMergingSiblings() {
  const { directory } = createDirectory();
  const catalog = directory.buildResourceCandidates([], {
    image_candidates: [
      {
        source: 'history', image_id: 'restored-new', resource_id: 'res:image:restored-new',
        identity_aliases: ['res:image:original'], reference_id: 'shared-group', description: '恢复图',
      },
      {
        source: 'history', image_id: 'original', resource_id: 'res:image:original',
        reference_id: 'shared-group', description: '原图',
      },
      {
        source: 'history', image_id: 'sibling', resource_id: 'res:image:sibling',
        reference_id: 'shared-group', description: '同批次另一张图',
      },
    ],
  });
  assert.strictEqual(catalog.length, 2, 'an explicit identity alias merges one restored object but shared reference_id never merges siblings');
  assert.deepStrictEqual(catalog.map(item => item.candidate_key), ['i1', 'i2']);
  assert.ok(catalog[0].identity_aliases.includes('res:image:original'));
  assert.strictEqual(catalog[1].id, 'sibling');
}

function testCanonicalCandidateDirectoryAttachesNonEnumerableMemoryMetadata() {
  const memoryCard = {
    type: 'image', source: 'history', image_id: 'memory-1', resource_id: 'res:image:memory-1',
    memory_index: 1, generation_index: 1, prompt: '橘猫',
  };
  const metadata = Object.freeze({ total_count: 3, eligible_count: 3, published_count: 1, truncated: true, strategies: ['semantic'] });
  const { directory, metadataSymbol } = createDirectory({ memorySelection: { cards: [memoryCard], metadata } });
  const catalog = directory.buildResourceCandidates([], { image_memory_cards: [memoryCard] }, '橘猫');
  assert.strictEqual(catalog.length, 1);
  assert.deepStrictEqual(catalog[metadataSymbol], {
    schema_version: 'resource_catalog.v1',
    image_memory: metadata,
  });
  assert.strictEqual(Object.keys(catalog).includes(String(metadataSymbol)), false);
}

function testRouteServiceUsesCanonicalCandidateModuleWithoutReembeddingImplementation() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const candidateSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-candidates.js'), 'utf8');
  assert.doesNotMatch(routeSource, /function canonicalCandidate\s*\(/);
  assert.doesNotMatch(routeSource, /function mergeCandidate\s*\(/);
  assert.doesNotMatch(routeSource, /function buildResourceCandidates\s*\(/);
  assert.match(routeSource, /createCanonicalCandidateDirectory/);
  assert.match(candidateSource, /function createCanonicalCandidateDirectory\s*\(/);
  assert.match(candidateSource, /function buildResourceCandidates\s*\(/);
  assert.doesNotMatch(candidateSource, /root\.ChatUIRouteCandidates\s*=/,
    'candidate composition must remain registry-only and not add another browser global');
  assert.strictEqual(typeof routeService.buildResourceCandidates, 'function');
}

module.exports = [
  testCanonicalCandidateDirectoryAssignsKeysRolesAndAvailability,
  testCanonicalCandidateDirectoryDeduplicatesIdentityAliasesWithoutMergingSiblings,
  testCanonicalCandidateDirectoryAttachesNonEnumerableMemoryMetadata,
  testRouteServiceUsesCanonicalCandidateModuleWithoutReembeddingImplementation,
];