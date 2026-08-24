'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const memoryModule = require('../../client/services/route-memory-retrieval');
const routeService = require('../../client/services/route-service');

function card(index, prompt = `作品-${index}`) {
  return {
    type: 'image',
    id: `image-${index}`,
    resource_id: `res:image:image-${index}`,
    reference_id: `ref-${index}`,
    prompt,
    memory_index: index,
    chronological_index: index,
    generation_index: index,
    generation_recency_index: 21 - index,
  };
}

function testMemoryRetrieverParsesOrdinalsAndSelectsStructuredHistory() {
  const retriever = memoryModule.createRouteMemoryRetriever();
  assert.strictEqual(retriever.parseOrdinalNumber('十二'), 12);
  assert.strictEqual(retriever.parseOrdinalNumber('20'), 20);
  const cards = Array.from({ length: 20 }, (_, index) => card(index + 1));
  assert.deepStrictEqual(
    retriever.structuredImageMemorySelection('把第八次生成的图改成黑白', cards).map(item => item.generation_index),
    [8],
  );
  assert.deepStrictEqual(
    retriever.structuredImageMemorySelection('把倒数第二次生成的图改一下', cards).map(item => item.generation_index),
    [19],
  );
}

function testMemoryRetrieverKeepsSemanticBudgetAndClarificationProtectedCards() {
  const cards = [
    card(1, '橘猫'), card(2, '橘猫'), card(3, '橘猫'), card(4, '雪山'),
  ];
  const retriever = memoryModule.createRouteMemoryRetriever({
    policy: { semanticLimit: 2, structuredLimit: 2, earlyHistoryLimit: 2 },
    sharedCandidateTokens: (input, item) => String(item.prompt).includes(input) ? [input] : [],
  });
  const result = retriever.selectImageMemoryCards('橘猫', cards, {
    clarification_context: {
      established_resources: [{ resource_id: 'res:image:image-4' }],
    },
  });
  assert.deepStrictEqual(result.cards.map(item => [item.id, item.memory_retrieval]), [
    ['image-4', 'clarification'],
    ['image-1', 'semantic'],
    ['image-2', 'semantic'],
  ]);
  assert.deepStrictEqual(result.metadata, {
    total_count: 4,
    eligible_count: 3,
    published_count: 3,
    truncated: true,
    strategies: ['clarification', 'semantic'],
  });
}

function testRouteServiceUsesMemoryModuleWithoutReembeddingRetrievalLogicOrGlobals() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const memorySource = fs.readFileSync(path.join(__dirname, '../../client/services/route-memory-retrieval.js'), 'utf8');
  assert.doesNotMatch(routeSource, /function structuredImageMemorySelection\s*\(/);
  assert.doesNotMatch(routeSource, /function selectImageMemoryCards\s*\(/);
  assert.match(routeSource, /require\('\.\/route-memory-retrieval'\)/);
  assert.match(memorySource, /function structuredImageMemorySelection\s*\(/);
  assert.match(memorySource, /function selectImageMemoryCards\s*\(/);
  assert.doesNotMatch(memorySource, /root\.ChatUIRouteMemoryRetrieval\s*=/,
    'the memory module must use the registry rather than add a browser global');
  assert.deepStrictEqual(routeService.IMAGE_MEMORY_RETRIEVAL_POLICY, memoryModule.IMAGE_MEMORY_RETRIEVAL_POLICY);
}

module.exports = [
  testMemoryRetrieverParsesOrdinalsAndSelectsStructuredHistory,
  testMemoryRetrieverKeepsSemanticBudgetAndClarificationProtectedCards,
  testRouteServiceUsesMemoryModuleWithoutReembeddingRetrievalLogicOrGlobals,
];