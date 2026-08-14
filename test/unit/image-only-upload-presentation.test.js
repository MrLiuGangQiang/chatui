'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const messageRecords = require('../../client/app/message-records');
const messageRenderer = require('../../client/ui/message-renderer');

function imageAttachment(name, index) {
  return {
    id: `image-${index}`,
    imageId: `image-${index}`,
    name,
    type: 'image/png',
    src: `indexeddb://image-${index}`,
    persistedSrc: `indexeddb://image-${index}`,
  };
}

function imageOnlyMessage() {
  const attachments = [
    imageAttachment('10_需求.png', 1),
    imageAttachment('11_评测.png', 2),
    imageAttachment('12_方案.png', 3),
    imageAttachment('13_业务.png', 4),
  ];
  return {
    role: 'user',
    content: attachments.map(item => `[image id=${item.id} name=${item.name} type=${item.type}]`).join('\n'),
    rawText: '已发送附件',
    attachmentContext: JSON.stringify({ prompt: '', attachments }),
  };
}

function testImageOnlyCanonicalPresentationDoesNotExposeFilenames() {
  const normalized = messageRecords.normalizeCanonicalMessage(imageOnlyMessage(), {
    sessionId: 'image-only-session',
    sequence: 0,
  });
  assert.strictEqual(normalized.presentation.kind, 'attachment');
  assert.strictEqual(normalized.presentation.displayText, '',
    'an image-only turn with no user text must render only the image previews');
  assert.doesNotMatch(normalized.presentation.displayText, /(?:10_需求|11_评测|12_方案|13_业务|\.png)/);
}

function testImageAttachmentSummaryNeverListsImageFilenames() {
  const markdown = messageRenderer.attachmentsSummaryMarkdown([
    imageAttachment('10_需求.png', 1),
    imageAttachment('11_评测.png', 2),
  ]);
  assert.strictEqual(markdown, '', 'image previews are sufficient; their filenames must not be repeated as attachment text');

  const mixed = messageRenderer.attachmentsSummaryMarkdown([
    imageAttachment('10_需求.png', 1),
    { name: '说明书.pdf', type: 'application/pdf' },
  ]);
  assert.doesNotMatch(mixed, /10_需求\.png/);
  assert.match(mixed, /说明书\.pdf/);
}

function testLiveImageOnlySubmitDoesNotSynthesizeAttachmentText() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.match(source, /renderUserMessageWithAttachments\(promptText,attachments\)/,
    'the live submit path must pass the actual empty prompt to the image preview renderer');
  assert.doesNotMatch(source, /renderUserMessageWithAttachments\(promptText\|\|["']已发送附件["'],attachments\)/,
    'the live submit path must not synthesize visible attachment text for an image-only turn');
}

module.exports = [
  testImageOnlyCanonicalPresentationDoesNotExposeFilenames,
  testImageAttachmentSummaryNeverListsImageFilenames,
  testLiveImageOnlySubmitDoesNotSynthesizeAttachmentText,
];
