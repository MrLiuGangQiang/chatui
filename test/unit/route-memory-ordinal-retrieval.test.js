'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeContext = require('../../client/core/image-route-context');

function assistantImageMessage(index, label = `作品编号-${String(index).padStart(2, '0')}`) {
  return {
    role: 'assistant',
    displayItemId: `image-result-${index}`,
    kind: 'image',
    content: `[图片生成完成] ${label}`,
    rawText: `[图片生成完成] ${label}`,
    imageContext: JSON.stringify({
      prompt: label,
      mode: 'image',
      target: 'previous',
      attachments: [{
        name: `result-${index}.png`,
        type: 'image/png',
        src: `indexeddb://result-${index}`,
      }],
    }),
  };
}

function completeMemory(count, labelForIndex = index => `作品编号-${String(index).padStart(2, '0')}`) {
  const messages = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({ role: 'user', content: `请求 ${index}` });
    messages.push(assistantImageMessage(index, labelForIndex(index)));
  }
  return routeContext.buildImageMemoryCards({ messages });
}

function memoryOnlyContext(cards) {
  const context = { image_candidates: [] };
  Object.defineProperty(context, 'image_memory_cards', {
    value: cards,
    enumerable: false,
    configurable: true,
  });
  return context;
}

function candidateByGeneration(candidates, generationIndex) {
  return candidates.find(candidate => Number(candidate.generation_index) === generationIndex);
}

function testAbsoluteGenerationOrdinalPublishesTheRequestedOldImage() {
  const cards = completeMemory(20);
  assert.strictEqual(cards.find(card => card.prompt === '作品编号-08')?.generation_index, 8,
    'image memory must preserve chronological generation position');

  const candidates = routeService.wireResourceCandidates(
    [],
    memoryOnlyContext(cards),
    '把第八次生成的图改成黑白',
  );
  const selected = candidateByGeneration(candidates, 8);

  assert.ok(selected, 'the eighth generated result must enter the model catalog even without keyword overlap');
  assert.strictEqual(selected.prompt, '作品编号-08');
  assert.strictEqual(candidates.filter(candidate => candidate.memory_retrieval === 'structured').length, 1,
    'an exact generation ordinal should publish one structured match instead of the whole history');
}

function testReverseGenerationOrdinalPublishesTheRequestedRecentImage() {
  const cards = completeMemory(20);
  const candidates = routeService.wireResourceCandidates(
    [],
    memoryOnlyContext(cards),
    '把倒数第二次生成的图改一下',
  );
  const selected = candidateByGeneration(candidates, 19);

  assert.ok(selected, 'reverse ordinals must resolve against generation recency');
  assert.strictEqual(selected.generation_recency_index, 2);
}

function testEarlyHistoryLocatorPublishesABoundedOldestSlice() {
  const cards = completeMemory(20);
  const candidates = routeService.wireResourceCandidates(
    [],
    memoryOnlyContext(cards),
    '把很早之前那张图改成黑白',
  );
  const generationIndexes = candidates.map(candidate => candidate.generation_index).sort((a, b) => a - b);

  assert.ok(generationIndexes.includes(1), 'broad early-history wording must expose the earliest recoverable result');
  assert.ok(candidates.length >= 2 && candidates.length <= 4,
    'broad early-history retrieval must expose a useful but bounded choice set');
  assert.ok(generationIndexes.every(index => index <= 4), 'early-history retrieval must not publish unrelated recent images');
}

function testUnrelatedImageMemoryStaysOutsideTheNormalCatalog() {
  const cards = completeMemory(12);
  const candidates = routeService.wireResourceCandidates(
    [],
    memoryOnlyContext(cards),
    '把橘猫背景改成雪山',
  );

  assert.deepStrictEqual(candidates, [], 'unrelated old images must not be published merely because history exists');
}

function testSemanticMemoryRetrievalHasAnExplicitCatalogBudget() {
  const cards = completeMemory(30, index => `橘猫版本-${String(index).padStart(2, '0')}`);
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '把橘猫改成黑白',
    context: memoryOnlyContext(cards),
  }).input[1].content);

  assert.strictEqual(payload.resource_candidates.length, 12,
    'normal semantic retrieval must obey the model-facing image-memory budget');
  assert.deepStrictEqual(payload.resource_catalog, {
    schema_version: 'resource_catalog.v1',
    image_memory: {
      total_count: 30,
      eligible_count: 30,
      published_count: 12,
      truncated: true,
      strategies: ['semantic'],
    },
  }, 'truncated catalogs must tell the model exactly what was bounded');
}

module.exports = [
  testAbsoluteGenerationOrdinalPublishesTheRequestedOldImage,
  testReverseGenerationOrdinalPublishesTheRequestedRecentImage,
  testEarlyHistoryLocatorPublishesABoundedOldestSlice,
  testUnrelatedImageMemoryStaysOutsideTheNormalCatalog,
  testSemanticMemoryRetrievalHasAnExplicitCatalogBudget,
];
