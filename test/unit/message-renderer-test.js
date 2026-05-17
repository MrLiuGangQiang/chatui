#!/usr/bin/env node
const assert = require('assert');
const { attachmentsSummaryMarkdown, userAttachmentPreviewItems, renderUserMessageParts } = require('../../client/ui/message-renderer');

assert.strictEqual(attachmentsSummaryMarkdown([{ name: 'a.pdf' }, { name: 'b.txt' }]), '\n\n📎 a.pdf\n📎 b.txt');
assert.strictEqual(attachmentsSummaryMarkdown([]), '');
assert.deepStrictEqual(userAttachmentPreviewItems([
  { name: 'a.png', isImage: true, dataUrl: 'data:x', previewWidth: 100, previewHeight: 50 },
  { name: 'b.pdf', isImage: false },
], () => ({ width: 90, height: 45 })).map(item => ({ name: item.name, src: item.src, w: item.thumbWidth, h: item.thumbHeight })), [{ name: 'a.png', src: 'data:x', w: 90, h: 45 }]);
assert.strictEqual(renderUserMessageParts({ markdownHtml: '<p>x</p>', imagePreviewHtml: '<img>', attachmentSummaryHtml: '<p>a</p>' }), '<p>x</p><img><p>a</p>');
console.log('message renderer ok');
