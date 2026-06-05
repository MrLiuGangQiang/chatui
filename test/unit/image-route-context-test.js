#!/usr/bin/env node
const assert = require('assert');
const {
  imageCandidateLabels,
  splitPromptSubjects,
  normalizeLastGeneratedImage,
  extractPersistedImageRefs,
  latestImageReferenceMeta,
  collectRecentImageReferences,
  findImageReferenceById,
  normalizeRoute,
  inferLocalImageRoute,
  buildRouteContext,
  routeContextSize,
  DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
} = require('../../client/core/image-route-context');

assert.deepStrictEqual(imageCandidateLabels('一只狗和 cat'), ['dog', 'cat']);
assert.deepStrictEqual(splitPromptSubjects('狗、猫', 2), [['dog'], ['cat']]);
assert.deepStrictEqual(normalizeLastGeneratedImage({ src: 'indexeddb://one', prompt: '狗' }).images[0].labels, ['dog']);
assert.deepStrictEqual(extractPersistedImageRefs('<img data-persisted-src="indexeddb://a" data-filename="a.png"><img data-filename="b.png" data-persisted-src="indexeddb://b">'), [
  { src: 'indexeddb://a', filename: 'a.png' },
  { src: 'indexeddb://b', filename: 'b.png' },
]);
assert.deepStrictEqual(latestImageReferenceMeta({ lastGeneratedImage: { images: [{ src: 'x' }], updatedAt: 20 }, latestUploadedImage: { attachments: [{ src: 'u' }], updatedAt: 10 } }).target, 'previous');
assert.deepStrictEqual(latestImageReferenceMeta({ lastGeneratedImage: { images: [{ src: 'x' }], updatedAt: 10 }, latestUploadedImage: { attachments: [{ src: 'u' }], updatedAt: 20 } }).target, 'uploaded');
const display = [
  { id: 'display_first', role: 'assistant', rawText: '[图片生成完成] 狗、猫', html: '<img data-persisted-src="indexeddb://dog" data-filename="dog.png"><img data-persisted-src="indexeddb://cat" data-filename="cat.png">' },
];
const refs = collectRecentImageReferences({ display, lastGeneratedImage: { prompt: '最新鸟', images: [{ src: 'indexeddb://bird', filename: 'bird.png', labels: ['bird'] }] }, limit: 6 });
assert.strictEqual(refs[0].reference_id, 'imgref_latest');
assert.strictEqual(refs[1].reference_id, 'imgref_display_first');
assert.strictEqual(refs[1].candidates[1].image_id, 'img_imgref_display_first_2');
const found = findImageReferenceById({ display, referenceId: 'imgref_display_first' });
assert.strictEqual(found.images.length, 2);
assert.strictEqual(found.images[0].imageId, 'img_imgref_display_first_1');
const route = normalizeRoute({ mode: 'edit_image', target: 'previous', use_previous_image: true, selected_reference_id: 'imgref_display_first', selected_image_ids: ['img_imgref_display_first_2'], confidence: 0.9, evidence: '用户说最开始的猫' });
assert.strictEqual(route.usePreviousImage, true);
assert.strictEqual(route.selectedReferenceId, 'imgref_display_first');
assert.deepStrictEqual(route.selectedImageIds, ['img_imgref_display_first_2']);
assert.strictEqual(normalizeRoute({ mode: 'image', confidence: 1 }).target, 'new');
assert.strictEqual(normalizeRoute({ mode: 'image', contextual_image_prompt: '按上文画海报', confidence: 1 }).contextualImagePrompt, '按上文画海报');
assert.strictEqual(inferLocalImageRoute('生成两张图片：一个红色圆点，一个黑色圆点').mode, 'image');
assert.strictEqual(inferLocalImageRoute('生成两张图片：一个红色圆点，一个黑色圆点').contextualImagePrompt, '生成两张图片：一个红色圆点，一个黑色圆点');
assert.strictEqual(inferLocalImageRoute('生成一张蓝色小猫图片').mode, 'image');
assert.strictEqual(inferLocalImageRoute('帮我画一个 logo').target, 'new');
assert.strictEqual(inferLocalImageRoute('不要生成图片，只描述方案'), null);
assert.strictEqual(inferLocalImageRoute('修改上一张图的背景').mode, 'edit_image');
assert.strictEqual(inferLocalImageRoute('修改上一张图的背景').target, 'previous');
const manyMessages = Array.from({ length: 800 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `消息${index} ${'x'.repeat(1000)}` }));
const largeContext = buildRouteContext({
  messages: manyMessages,
  lastGeneratedImage: { reference_id: 'imgref_latest', prompt: 'latest', count: 1, candidates: [] },
  latestUploadedImage: null,
  latestImageReference: { target: 'previous', count: 1 },
  recentImageReferences: refs,
  maxChars: DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
});
assert.ok(routeContextSize(largeContext) <= DEFAULT_ROUTE_CONTEXT_MAX_CHARS);
assert.ok(largeContext.recent_messages.length > 8, 'route context should not be fixed to 8 turns');
assert.strictEqual(largeContext.recent_image_references[0].reference_id, 'imgref_latest');
console.log('image route context ok');
