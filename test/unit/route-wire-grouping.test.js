'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function payloadFor({ attachments = [], context = {} } = {}) {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '看看这个',
    attachments,
    context,
  });
  return JSON.parse(payload.input.find(item => item.role === 'user').content);
}

function testCurrentAttachmentsAreGroupedSeparatelyFromHistoryCandidates() {
  const wire = payloadFor({
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: 'file-current',
      file_id: 'file-current',
      name: 'report.pdf',
      type: 'application/pdf',
      is_image: false,
      has_extracted_text: true,
    }],
    context: {
      recent_messages: [],
      image_candidates: [],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(wire.context.current_attachments, [{
    type: 'file',
    index: 1,
    label: 'report.pdf',
  }], 'current uploads must be published as an explicit current-attachments group');
}

function testHistoryCandidatesAreNotListedAsCurrentAttachments() {
  const wire = payloadFor({
    context: {
      recent_messages: [],
      image_candidates: [{
        index: 1,
        source_index: 1,
        source: 'history',
        image_id: 'img-old',
        reference_id: 'imgref-old',
        target: 'previous',
        message_index: 1,
        description: '一张历史图片',
      }],
      file_candidates: [],
    },
  });
  assert.strictEqual(wire.context.current_attachments, undefined,
    'historical candidates must not be mislabeled as current attachments');
}

module.exports = [
  testCurrentAttachmentsAreGroupedSeparatelyFromHistoryCandidates,
  testHistoryCandidatesAreNotListedAsCurrentAttachments,
];
