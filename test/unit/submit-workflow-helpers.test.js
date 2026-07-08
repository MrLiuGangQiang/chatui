const assert = require('assert');

const helpers = require('../../client/app/submit-workflow.helpers');

function testSubmitHelpersParseAndPreviewQuoteContext() {
  assert.deepStrictEqual(helpers.parseContextValue('{"role":"user","content":" hello  world "}'), { role: 'user', content: ' hello  world ' });
  assert.strictEqual(helpers.parseContextValue('{bad'), null);
  assert.deepStrictEqual(helpers.parseContextValue({ ok: true }), { ok: true });
  const preview = helpers.previewQuoteText('  第一行\n第二行  '.repeat(10));
  assert.strictEqual(preview.length, 48);
  assert.ok(preview.startsWith('第一行 第二行 第一行 第二行'));
  const html = helpers.withPendingQuotePreview('<p>正文</p>', { role: 'assistant', content: '<b>结果</b>' });
  assert.ok(html.includes('sent-quote-preview'));
  assert.ok(html.includes('追问 AI'));
  assert.ok(html.includes('&lt;b&gt;结果&lt;/b&gt;'));
  assert.ok(html.endsWith('<p>正文</p>'));
  assert.strictEqual(helpers.withPendingQuotePreview('<button class="sent-quote-preview"></button>', { role: 'user', content: 'x' }), '<button class="sent-quote-preview"></button>');
}

function testSubmitHelpersUnderstandingClassifiers() {
  assert.strictEqual(helpers.isImageUnderstandingChat('这张图里有什么文字？'), true);
  assert.strictEqual(helpers.isImageUnderstandingChat('看看这个'), true);
  assert.strictEqual(helpers.isImageUnderstandingChat('看一下'), true);
  assert.strictEqual(helpers.isImageUnderstandingChat('这是什么'), true);
  assert.strictEqual(helpers.isImageUnderstandingChat('解释一下 Promise'), false);
  assert.strictEqual(helpers.isFileUnderstandingChat('总结这个 PDF 里的内容'), true);
  assert.strictEqual(helpers.isFileUnderstandingChat('帮我画一只猫'), false);
}

function testSubmitHelpersImageIndexGuidePreservesOriginalIndexes() {
  assert.strictEqual(helpers.originalImageIndex({ sourceIndex: 3, imageId: 'img_any_1' }, 0), 3);
  assert.strictEqual(helpers.originalImageIndex({ imageId: 'img_ref_4' }, 0), 4);
  const guide = helpers.imageAttachmentIndexGuide([
    { sourceIndex: 2, imageId: 'img_a_2', name: '第二张.png', type: 'image/png' },
    { sourceIndex: 5, imageId: 'img_a_5', name: '第五张.png', type: 'image/png' },
  ]);
  assert.ok(guide.includes('图片引用说明'));
  assert.ok(guide.includes('当前随附图片1 = 原消息第2张'));
  assert.ok(guide.includes('image_id=img_a_5'));
  assert.strictEqual(helpers.imageAttachmentIndexGuide([{ imageId: 'img_a_1', type: 'image/png' }]), '');
}

module.exports = [
  testSubmitHelpersParseAndPreviewQuoteContext,
  testSubmitHelpersUnderstandingClassifiers,
  testSubmitHelpersImageIndexGuidePreservesOriginalIndexes,
];
