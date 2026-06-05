const assert = require('assert');
const workflow = require('../../client/app/image-result-workflow');

(async function run() {
  const saved = [];
  const out = await workflow.imageResultToHtml({ data: [{ url: 'https://example.com/a.png' }, { b64_json: 'abc' }] }, '1.2s', { prompt: 'red dot and black dot', sessionId: 's1' }, {
    extractImageResult: result => ({ kind: 'image', images: result.data.map(item => ({ src: item.url || `data:image/png;base64,${item.b64_json}`, raw: item.url || '[base64 image]', url: item.url || '' })) }),
    escapeHtml: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    getConfig: () => ({}),
    settleWithin: async (promise, _ms, fallback) => promise.catch ? promise.catch(() => fallback) : promise,
    persistImageSrc: async src => ({ persistedSrc: `indexeddb://${src}`, displaySrc: src }),
    imageSrcSize: async () => ({ width: 512, height: 256 }),
    fitImageThumb: () => ({ width: 180, height: 90 }),
    splitPromptSubjects: () => [['red'], ['black']],
    imageCandidateLabels: () => ['dot'],
    makeImageItemId: (scope, index) => `${scope}-${index}`,
    downloadAllImagesButtonHtml: () => '<button data-download-all-images="1">download</button>',
    saveLatestGeneratedImage: (sessionId, latest) => saved.push({ sessionId, latest }),
  });
  assert.ok(out.html.includes('generated-image-grid'));
  assert.ok(out.html.includes('data-generated-images="1"'));
  assert.ok(out.html.includes('（2 张）'));
  assert.ok(out.html.includes('data-image-index="1"'));
  assert.ok(!out.html.includes('generated-image-index'));
  assert.ok(out.html.includes('alt="第 2 张生成图片"'));
  assert.ok(out.html.includes('data-download-all-images'));
  assert.ok(out.html.includes('src="indexeddb://https://example.com/a.png"'), 'rendered image src should use durable persisted reference, not transient blob/display URL');
  assert.strictEqual(out.metaText, 'RT 1.2s');
  assert.strictEqual(saved[0].sessionId, 's1');
  assert.strictEqual(saved[0].latest.images.length, 2);

  const empty = await workflow.imageResultToHtml({}, '', {}, { extractImageResult: () => ({ kind: 'empty', raw: '{}' }), escapeHtml: String });
  assert.strictEqual(empty.html, '没有返回图片数据');
  console.log('app image result workflow ok');
})();
